// Service worker: the coordination hub. It owns the offscreen-document
// lifecycle (where recording + the pipeline actually run), routes messages
// between the popup, the Meet content script and the offscreen document, and
// keeps a small "recorder state" that the UI reflects.
//
// Audio capture itself cannot happen here (service workers have no media APIs),
// so the heavy lifting lives in offscreen.js. The tab's MediaStream id is minted
// in the popup (which holds the user gesture + activeTab) and passed in.
import * as store from "./lib/store.js";
import { STAGE_LABELS } from "./lib/pipeline.js";

const OFFSCREEN_PATH = "offscreen.html";

// --- Recorder state (mirrored to storage so the popup survives SW restarts) --

let state = {
  phase: "idle", // idle | recording | processing | done | failed
  meetingId: null,
  title: null,
  startedAt: null,
  stage: null, // pipeline stage key while processing
  notionURL: null,
  error: null,
};

async function loadState() {
  const saved = (await chrome.storage.local.get("wn_recorder_state")).wn_recorder_state;
  if (saved) state = saved;
}
async function setState(patch) {
  state = { ...state, ...patch };
  await chrome.storage.local.set({ wn_recorder_state: state });
  broadcast();
}

function broadcast() {
  const msg = { type: "WN_STATE", state };
  // To the popup / options (extension pages).
  chrome.runtime.sendMessage(msg).catch(() => {});
  // To every open Meet tab (content script).
  chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  });
}

// --- Offscreen document lifecycle ---------------------------------------

async function hasOffscreen() {
  // getContexts is the reliable check on modern Chrome.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
    justification:
      "Record the meeting tab audio and your microphone, then upload and process the recording.",
  });
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...message }).catch(() => {});
}

// --- Message handling ----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

async function handle(msg, sender) {
  switch (msg.type) {
    case "WN_GET_STATE": {
      const [session, meetings, settings, micGranted] = await Promise.all([
        store.getSession(),
        store.getMeetings(),
        store.getSettings(),
        store.getMicGranted(),
      ]);
      return { ok: true, state, session, meetings, settings, micGranted };
    }

    case "WN_RECORD_TAB": {
      // msg: { tabId, title, calendar? } — the stream id is minted HERE in the
      // service worker: what authorizes it is the activeTab grant on the target
      // tab (from an icon click, the context menu or the keyboard shortcut),
      // not which extension context asks. This also works when the panel runs
      // as an iframe inside the Meet page (Arc-compatible layout).
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId });
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
      return beginRecording({ streamId, title: msg.title, calendar: msg.calendar });
    }

    case "WN_STOP":
      if (state.phase === "recording") await sendToOffscreen({ type: "STOP" });
      return { ok: true };

    case "WN_CANCEL":
      if (state.phase === "recording") await sendToOffscreen({ type: "CANCEL" });
      await setState({ phase: "idle", meetingId: null, stage: null, error: null });
      return { ok: true };

    case "WN_DISMISS":
      await setState({ phase: "idle", stage: null, error: null, notionURL: null });
      return { ok: true };

    // --- offscreen -> background lifecycle events ---
    case "WN_REC_STARTED":
      // Capture actually began (state is already "recording" from WN_START).
      return { ok: true };

    case "WN_REC_STAGE":
      await setState({ phase: "processing", stage: msg.stage });
      return { ok: true };

    case "WN_REC_DONE":
      // offscreen already saved the meeting to the store.
      await setState({
        phase: "done",
        stage: null,
        notionURL: msg.notionURL || null,
        error: null,
      });
      return { ok: true };

    case "WN_REC_FAILED":
      await setState({ phase: "failed", stage: null, error: msg.error || "Processing failed." });
      return { ok: true };

    // --- Actions on past meetings (run in offscreen so they survive) ---
    case "WN_RETRY": {
      const meeting = (await store.getMeetings()).find((m) => m.id === msg.id);
      const session = await store.getSession();
      if (!meeting || !session) return { ok: false, error: "Not available." };
      await ensureOffscreen();
      await setState({ phase: "processing", meetingId: meeting.id, stage: null, error: null });
      await sendToOffscreen({ type: "RETRY", meeting, session, settings: await store.getSettings() });
      return { ok: true };
    }

    case "WN_EXPORT": {
      const meeting = (await store.getMeetings()).find((m) => m.id === msg.id);
      const session = await store.getSession();
      if (!meeting || !session) return { ok: false, error: "Not available." };
      await ensureOffscreen();
      await setState({ phase: "processing", meetingId: meeting.id, stage: "exporting", error: null });
      await sendToOffscreen({ type: "EXPORT", meeting, session, settings: await store.getSettings() });
      return { ok: true };
    }

    case "WN_DISCARD":
      await store.removeMeeting(msg.id);
      broadcast();
      return { ok: true };

    // --- offscreen -> background: persistence (offscreen has no chrome.storage) ---
    case "WN_MEETING_UPSERT":
      await store.upsertMeeting(msg.meeting);
      broadcast();
      return { ok: true };

    case "WN_MEETING_REMOVE":
      await store.removeMeeting(msg.id);
      broadcast();
      return { ok: true };

    case "WN_MIC_GRANTED":
      await store.setMicGranted(true);
      broadcast();
      return { ok: true };

    case "WN_SESSION_REFRESHED":
      if (msg.session) await store.setSession(msg.session);
      return { ok: true };

    case "WN_SETTINGS_CHANGED":
      broadcast();
      return { ok: true };

    // The panel iframe asks its host page (via us) to close it.
    case "WN_CLOSE_PANEL":
      if (sender?.tab?.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, { type: "WN_TOGGLE_PANEL", ensure: "close" }).catch(() => {});
      }
      return { ok: true };

    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

/** Starts a recording from an already-minted tab-capture stream id. */
async function beginRecording({ streamId, title, calendar }) {
  if (state.phase === "recording") return { ok: false, error: "Already recording." };
  const session = await store.getSession();
  if (!session) return { ok: false, error: "Sign in first." };
  const settings = await store.getSettings();
  const meeting = {
    id: crypto.randomUUID(),
    title: title || `Meeting ${new Date().toLocaleString()}`,
    startedAt: new Date().toISOString(),
    calendar: calendar || null,
  };
  await ensureOffscreen();
  await setState({
    phase: "recording",
    meetingId: meeting.id,
    title: meeting.title,
    startedAt: meeting.startedAt,
    stage: null,
    notionURL: null,
    error: null,
  });
  await sendToOffscreen({ type: "START", streamId, meeting, session, settings });
  return { ok: true, meetingId: meeting.id };
}

// --- Toolbar icon, context menu, shortcut -------------------------------
// Arc does not render Chrome's native side panel, so the panel is an iframe
// the content script docks INSIDE the Meet page (it pushes the page content
// with a margin — no overlay). The icon / context menu / shortcut are also
// what grant activeTab on the call's tab, which authorizes tabCapture there.

const MEET_URL = /^https:\/\/meet\.google\.com\//;

function isMeetTab(tab) {
  return !!tab?.id && MEET_URL.test(tab.url || "");
}

/** Opens the docked panel in a Meet tab, injecting the content script if the
 *  copy in the page went stale (e.g. after an extension reload). */
async function openPanelInTab(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "WN_TOGGLE_PANEL", ensure: "open" });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "WN_TOGGLE_PANEL", ensure: "open" });
    } catch (_) {
      /* tab not reachable */
    }
  }
}

function titleFromTab(tab) {
  let t = (tab?.title || "").replace(/\s*[-–]\s*Google Meet\s*$/i, "").replace(/^Meet\s*[-–]\s*/i, "").trim();
  if (!t || /^meet\.google\.com/i.test(t)) t = `Meeting ${new Date().toLocaleString()}`;
  return t;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (isMeetTab(tab)) {
    await openPanelInTab(tab);
  } else {
    // Not on a call: open the dashboard (same page, as a full tab).
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/sidepanel.html") });
  }
});

function ensureMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "wn-record",
      title: "Winday Notetaker — Enregistrer ce call",
      contexts: ["page"],
      documentUrlPatterns: ["https://meet.google.com/*"],
    });
    chrome.contextMenus.create({
      id: "wn-panel",
      title: "Winday Notetaker — Ouvrir le panneau",
      contexts: ["page"],
      documentUrlPatterns: ["https://meet.google.com/*"],
    });
  });
}

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (!isMeetTab(tab)) return;
  if (info.menuItemId === "wn-panel") {
    await openPanelInTab(tab);
    return;
  }
  if (info.menuItemId === "wn-record") {
    await openPanelInTab(tab);
    if (state.phase === "recording") return;
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await beginRecording({ streamId, title: titleFromTab(tab) });
    } catch (e) {
      await setState({ phase: "failed", stage: null, error: String(e?.message || e) });
    }
  }
});

// Expose stage labels to any page that wants them via a getter message.
export { STAGE_LABELS };

function boot() {
  loadState();
  ensureMenus();
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();
