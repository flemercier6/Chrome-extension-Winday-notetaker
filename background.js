// Service worker: the coordination hub. It owns the offscreen-document
// lifecycle, routes messages between the panel (an iframe the content script
// docks over the Meet page), the pill and the offscreen recorder, and keeps a
// small "recorder state" that every surface mirrors.
//
// Recording can live in TWO hosts:
//   - offscreen document ("offscreen"): silent tabCapture path — used when the
//     call's tab carries the activeTab grant (icon click / context menu / ⌘⇧9)
//     or a Chromium that honors the meet.google.com host permission;
//   - the panel iframe ("panel"): getDisplayMedia fallback — used when silent
//     capture is refused, since the standard share dialog needs no grant and
//     exists in every Chromium (Arc included).
import * as store from "./lib/store.js";
import { STAGE_LABELS } from "./lib/pipeline.js";

const OFFSCREEN_PATH = "offscreen.html";

// --- Recorder state (mirrored to storage so the UI survives SW restarts) --

let state = {
  phase: "idle", // idle | recording | processing | done | failed
  meetingId: null,
  title: null,
  startedAt: null,
  stage: null, // pipeline stage key while processing
  notionURL: null,
  error: null,
  recorderHost: null, // "offscreen" | "panel" while recording
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
  chrome.runtime.sendMessage(msg).catch(() => {});
  chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  });
}

// --- Offscreen document lifecycle ---------------------------------------

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
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
  // WN_OPEN_PANEL is handled synchronously: in native mode, sidePanel.open()
  // consumes the user-gesture token from the pill's click, and that token
  // does not survive an `await`. In docked mode the content script is told to
  // open its own iframe.
  if (msg?.type === "WN_OPEN_PANEL") {
    if (panelModeCache === "native" && chrome.sidePanel && sender?.tab) {
      chrome.sidePanel
        .open({ tabId: sender.tab.id })
        .then(() => sendResponse({ ok: true, mode: "native" }))
        .catch((e) => sendResponse({ ok: false, mode: "native", error: String(e?.message || e) }));
    } else {
      sendResponse({ ok: true, mode: "docked" });
    }
    return true;
  }
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
      // Try the SILENT path: mint a tabCapture stream id here and record in
      // the offscreen document. When Chromium refuses (no activeTab grant on
      // the call's tab), tell the panel to run the getDisplayMedia fallback
      // itself — the share dialog needs no grant.
      const tab = await resolveMeetTab(msg.tabId, sender);
      if (!tab) return { ok: false, error: "Aucun onglet Google Meet trouvé — ouvrez votre call, puis réessayez." };
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        return await beginRecording({ streamId, title: msg.title || titleFromTab(tab), calendar: msg.calendar });
      } catch (_) {
        return { ok: false, needsPickerFallback: true, title: msg.title || titleFromTab(tab) };
      }
    }

    // The panel started a fallback (getDisplayMedia) recording in its iframe.
    case "WN_PANEL_REC_STARTED":
      await setState({
        phase: "recording",
        meetingId: msg.meeting?.id || null,
        title: msg.meeting?.title || null,
        startedAt: msg.meeting?.startedAt || new Date().toISOString(),
        stage: null,
        notionURL: null,
        error: null,
        recorderHost: "panel",
      });
      return { ok: true };

    case "WN_STOP":
      if (state.phase === "recording") {
        if (state.recorderHost === "panel") chrome.runtime.sendMessage({ type: "WN_PANEL_STOP" }).catch(() => {});
        else await sendToOffscreen({ type: "STOP" });
      }
      return { ok: true };

    case "WN_CANCEL":
      if (state.phase === "recording") {
        if (state.recorderHost === "panel") chrome.runtime.sendMessage({ type: "WN_PANEL_CANCEL" }).catch(() => {});
        else await sendToOffscreen({ type: "CANCEL" });
      }
      await setState({ phase: "idle", meetingId: null, stage: null, error: null, recorderHost: null });
      return { ok: true };

    case "WN_DISMISS":
      await setState({ phase: "idle", stage: null, error: null, notionURL: null, recorderHost: null });
      return { ok: true };

    // --- recorder host -> background lifecycle events ---
    case "WN_REC_STARTED":
      return { ok: true };

    case "WN_REC_STAGE":
      await setState({ phase: "processing", stage: msg.stage, recorderHost: null });
      return { ok: true };

    case "WN_REC_DONE":
      await setState({ phase: "done", stage: null, notionURL: msg.notionURL || null, error: null, recorderHost: null });
      return { ok: true };

    case "WN_REC_FAILED":
      await setState({ phase: "failed", stage: null, error: msg.error || "Processing failed.", recorderHost: null });
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

    // --- persistence relays (recorder hosts do not own chrome.storage) ---
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
      await refreshPanelMode();
      broadcast();
      return { ok: true };

    // The panel's ✕: ask its host page to hide the docked iframe.
    case "WN_CLOSE_PANEL":
      if (sender?.tab?.id != null) {
        chrome.tabs.sendMessage(sender.tab.id, { type: "WN_TOGGLE_PANEL", ensure: "close" }).catch(() => {});
      }
      return { ok: true };

    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

/** Starts an offscreen (silent-path) recording from a tabCapture stream id. */
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
    recorderHost: "offscreen",
  });
  await sendToOffscreen({ type: "START", streamId, meeting, session, settings });
  return { ok: true, meetingId: meeting.id };
}

// --- Meet tab helpers, toolbar icon, context menu ------------------------

const MEET_URL = /^https:\/\/meet\.google\.com\//;

function isMeetTab(tab) {
  return !!tab?.id && MEET_URL.test(tab.url || "");
}

/** The tab to record: explicit id, else the panel's host tab (the panel is an
 *  iframe inside the Meet page, so sender.tab IS the call's tab), else any
 *  open Meet tab (audible first, then most recently used). */
async function resolveMeetTab(explicitId, sender) {
  if (explicitId != null) {
    const tab = await chrome.tabs.get(explicitId).catch(() => null);
    if (tab) return tab;
  }
  if (isMeetTab(sender?.tab)) return sender.tab;
  const meetTabs = await new Promise((resolve) =>
    chrome.tabs.query({ url: "https://meet.google.com/*" }, resolve),
  );
  if (!meetTabs || meetTabs.length === 0) return null;
  return meetTabs.find((t) => t.audible) ||
    meetTabs.slice().sort((a, z) => (z.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

function titleFromTab(tab) {
  let t = (tab?.title || "").replace(/\s*[-–]\s*Google Meet\s*$/i, "").replace(/^Meet\s*[-–]\s*/i, "").trim();
  if (!t || /^meet\.google\.com/i.test(t)) t = `Meeting ${new Date().toLocaleString()}`;
  return t;
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

// --- Panel mode ------------------------------------------------------------
// "native": the browser renders its real side panel (Chrome, Dia) — the icon
// click opens it via setPanelBehavior, and pushes the page natively.
// "docked": browsers that never render that UI (Arc) — the icon click reaches
// action.onClicked (the behavior flag is off) and we dock the iframe instead.
// Cached in memory so gesture-sensitive paths never await storage.
let panelModeCache = "native";

async function refreshPanelMode() {
  const settings = await store.getSettings();
  panelModeCache = settings.panelMode === "docked" ? "docked" : "native";
  chrome.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: panelModeCache === "native" })
    .catch(() => {});
}

// Toolbar icon (and ⌘⇧9 via _execute_action). In native mode Chromium opens
// the side panel itself and this listener never fires. In docked mode: on a
// Meet tab, open the docked panel — that click is ALSO the activeTab grant
// that unlocks silent capture. Elsewhere, open a full-tab dashboard.
chrome.action.onClicked.addListener(async (tab) => {
  if (isMeetTab(tab)) {
    await openPanelInTab(tab);
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel/sidepanel.html") });
  }
});

function ensureMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "wn-record",
      title: "Winday Meet — Enregistrer ce call",
      contexts: ["page"],
      documentUrlPatterns: ["https://meet.google.com/*"],
    });
    chrome.contextMenus.create({
      id: "wn-panel",
      title: "Winday Meet — Ouvrir le panneau",
      contexts: ["page"],
      documentUrlPatterns: ["https://meet.google.com/*"],
    });
  });
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!isMeetTab(tab)) return;
  // Open the panel synchronously first: in native mode sidePanel.open() needs
  // the menu click's user-gesture token, which an `await` would drop.
  if (panelModeCache === "native" && chrome.sidePanel) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } else {
    openPanelInTab(tab);
  }
  if (info.menuItemId === "wn-record") {
    // The menu click grants activeTab: capture silently.
    recordFromMenu(tab);
  }
});

async function recordFromMenu(tab) {
  if (state.phase === "recording") return;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await beginRecording({ streamId, title: titleFromTab(tab) });
  } catch (e) {
    await setState({ phase: "failed", stage: null, error: String(e?.message || e) });
  }
}

// Expose stage labels to any page that wants them via a getter message.
export { STAGE_LABELS };

function boot() {
  loadState();
  ensureMenus();
  refreshPanelMode();
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();
