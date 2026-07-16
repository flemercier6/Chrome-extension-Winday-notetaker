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
      // The stream id is minted HERE in the service worker. Paths, in order:
      //  1. tabCapture (silent) — authorized by the activeTab grant on the
      //     call's tab (icon click / context menu / ⌘⇧9) or, on Chromium
      //     builds that honor it, by the meet.google.com host permission.
      //  2. The native share picker (desktopCapture) — no grant needed.
      //  3. Both unavailable (e.g. Arc without a picker UI): an actionable
      //     error telling the user the two one-gesture paths that DO grant.
      const tab = await resolveMeetTab(msg.tabId);
      if (!tab) return { ok: false, error: "Aucun onglet Google Meet trouvé — ouvrez votre call, puis réessayez." };
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        return await beginRecording({ streamId, captureSource: "tab", title: msg.title || titleFromTab(tab), calendar: msg.calendar });
      } catch (_) {
        const picked = await chooseTabMedia();
        if (!picked) {
          return {
            ok: false,
            error:
              "Chromium demande un geste d'autorisation : clic droit sur la page du call → " +
              "« Winday Notetaker — Enregistrer ce call » (démarre aussitôt), ou ⌘⇧9 sur l'onglet du call puis réessayez ici.",
          };
        }
        return beginRecording({ streamId: picked, captureSource: "desktop", title: msg.title || titleFromTab(tab), calendar: msg.calendar });
      }
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

    // Open the companion panel window (from the pill or any UI).
    case "WN_OPEN_PANEL":
      await openPanelWindow(sender?.tab || null);
      return { ok: true };

    // The panel's ✕: close the companion window (restore happens onRemoved).
    case "WN_CLOSE_PANEL": {
      const b = await getBinding();
      if (b?.panelWindowId != null) chrome.windows.remove(b.panelWindowId).catch(() => {});
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

/** Shows the native share picker restricted to tabs (with the share-audio
 *  toggle). Resolves to a desktop-capture stream id, or null if cancelled. */
function chooseTabMedia() {
  return new Promise((resolve) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(["tab", "audio"], (streamId) => resolve(streamId || null));
    } catch (_) {
      resolve(null);
    }
  });
}

/** Starts a recording from an already-minted capture stream id.
 *  captureSource: "tab" (tabCapture) | "desktop" (share picker). */
async function beginRecording({ streamId, captureSource = "tab", title, calendar }) {
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
  await sendToOffscreen({ type: "START", streamId, captureSource, meeting, session, settings });
  return { ok: true, meetingId: meeting.id };
}

// --- Companion panel window ----------------------------------------------
// A CSS-only "push" cannot work on Meet: its layout is computed in JS from
// window.innerWidth, which no stylesheet can change — shrunk boxes just get
// overflowed and the panel ends up looking like an overlay. The only push
// that works everywhere (Arc included, which has no native side-panel UI) is
// at the WINDOW level: shrink the call's browser window by the panel width
// and dock a popup window in the freed strip. Meet then re-lays-out natively,
// exactly as when the user narrows the window by hand.

const MEET_URL = /^https:\/\/meet\.google\.com\//;
const PANEL_WIDTH = 380;
const MIN_MAIN_WIDTH = 520;

function isMeetTab(tab) {
  return !!tab?.id && MEET_URL.test(tab.url || "");
}

async function getBinding() {
  return (await chrome.storage.local.get("wn_panel_binding")).wn_panel_binding || null;
}
async function saveBinding(b) {
  await chrome.storage.local.set({ wn_panel_binding: b });
}
async function clearBinding() {
  await chrome.storage.local.remove("wn_panel_binding");
}

/** Opens (or focuses) the companion panel window next to `fromTab`'s window,
 *  shrinking that window to make room — a real push, independent of page CSS. */
async function openPanelWindow(fromTab) {
  const existing = await getBinding();
  if (existing?.panelWindowId != null) {
    try {
      await chrome.windows.update(existing.panelWindowId, { focused: true });
      if (fromTab && isMeetTab(fromTab) && existing.meetTabId !== fromTab.id) {
        existing.meetTabId = fromTab.id;
        await saveBinding(existing);
      }
      return;
    } catch (_) {
      await clearBinding(); // stale binding (window already gone)
    }
  }

  let main;
  try {
    main = fromTab
      ? await chrome.windows.get(fromTab.windowId)
      : await chrome.windows.getLastFocused();
  } catch (_) {
    main = await chrome.windows.getLastFocused();
  }

  // A maximized window refuses width updates on some platforms — normalize.
  if (main.state === "maximized") {
    await chrome.windows.update(main.id, { state: "normal" }).catch(() => {});
    main = await chrome.windows.get(main.id);
  }

  let mainWidth = main.width;
  let restoreWidth = null;
  if (main.state !== "fullscreen" && main.width - PANEL_WIDTH >= MIN_MAIN_WIDTH) {
    restoreWidth = main.width;
    mainWidth = main.width - PANEL_WIDTH;
    await chrome.windows.update(main.id, { width: mainWidth }).catch(() => {});
  }

  const panel = await chrome.windows.create({
    url: chrome.runtime.getURL("sidepanel/sidepanel.html"),
    type: "popup",
    width: PANEL_WIDTH,
    height: main.height,
    left: (main.left ?? 0) + mainWidth,
    top: main.top ?? 0,
    focused: true,
  });

  await saveBinding({
    panelWindowId: panel.id,
    mainWindowId: main.id,
    meetTabId: fromTab && isMeetTab(fromTab) ? fromTab.id : null,
    restoreWidth,
  });
}

// Keep the panel glued to the call window when the latter moves or resizes.
chrome.windows.onBoundsChanged?.addListener(async (win) => {
  const b = await getBinding();
  if (!b || win.id !== b.mainWindowId || b.panelWindowId == null) return;
  chrome.windows
    .update(b.panelWindowId, {
      left: (win.left ?? 0) + (win.width ?? 0),
      top: win.top ?? 0,
      height: win.height,
    })
    .catch(() => {});
});

// Closing either window unwinds the pair: panel closed -> give the width back;
// call window closed -> close the panel.
chrome.windows.onRemoved.addListener(async (winId) => {
  const b = await getBinding();
  if (!b) return;
  if (winId === b.panelWindowId) {
    if (b.mainWindowId != null && b.restoreWidth != null) {
      chrome.windows.update(b.mainWindowId, { width: b.restoreWidth }).catch(() => {});
    }
    await clearBinding();
  } else if (winId === b.mainWindowId) {
    if (b.panelWindowId != null) chrome.windows.remove(b.panelWindowId).catch(() => {});
    await clearBinding();
  }
});

/** The tab to record: explicit id, else the tab the panel was opened from,
 *  else any open Meet tab (audible first, then most recently used). */
async function resolveMeetTab(explicitId) {
  if (explicitId != null) {
    const tab = await chrome.tabs.get(explicitId).catch(() => null);
    if (tab) return tab;
  }
  const b = await getBinding();
  if (b?.meetTabId != null) {
    const tab = await chrome.tabs.get(b.meetTabId).catch(() => null);
    if (isMeetTab(tab)) return tab;
  }
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

// Toolbar icon (and ⌘⇧9 via _execute_action): opens the companion panel.
// On a Meet tab this click is ALSO the activeTab grant that unlocks silent
// tab capture for the record button.
chrome.action.onClicked.addListener(async (tab) => {
  await openPanelWindow(tab || null);
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
    await openPanelWindow(tab);
    return;
  }
  if (info.menuItemId === "wn-record") {
    // The menu click grants activeTab on the call's tab: capture silently,
    // then surface the panel so the live status is visible.
    if (state.phase === "recording") return;
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await beginRecording({ streamId, captureSource: "tab", title: titleFromTab(tab) });
    } catch (e) {
      await setState({ phase: "failed", stage: null, error: String(e?.message || e) });
    }
    await openPanelWindow(tab);
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
