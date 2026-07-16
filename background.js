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

    case "WN_START": {
      // msg: { streamId, tabId, title, calendar? }
      if (state.phase === "recording") return { ok: false, error: "Already recording." };
      const settings = await store.getSettings();
      const micGranted = await store.getMicGranted();
      const meeting = {
        id: crypto.randomUUID(),
        title: msg.title || `Meeting ${new Date().toLocaleString()}`,
        startedAt: new Date().toISOString(),
        calendar: msg.calendar || null,
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
      await sendToOffscreen({
        type: "START",
        streamId: msg.streamId,
        meeting,
        settings,
        micGranted,
      });
      return { ok: true, meetingId: meeting.id };
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
    case "WN_RETRY":
      await ensureOffscreen();
      await sendToOffscreen({ type: "RETRY", meetingId: msg.id });
      return { ok: true };

    case "WN_EXPORT":
      await ensureOffscreen();
      await sendToOffscreen({ type: "EXPORT", meetingId: msg.id });
      return { ok: true };

    case "WN_DISCARD":
      await store.removeMeeting(msg.id);
      broadcast();
      return { ok: true };

    case "WN_SETTINGS_CHANGED":
      broadcast();
      return { ok: true };

    case "WN_OPEN_POPUP":
      if (chrome.action.openPopup) {
        try {
          await chrome.action.openPopup();
          return { ok: true };
        } catch (_) {
          return { ok: false, error: "Click the Winday Notetaker toolbar icon to start." };
        }
      }
      return { ok: false, error: "Click the Winday Notetaker toolbar icon to start." };

    default:
      return { ok: false, error: `Unknown message: ${msg.type}` };
  }
}

// Expose stage labels to any page that wants them via a getter message.
export { STAGE_LABELS };

chrome.runtime.onInstalled.addListener(loadState);
chrome.runtime.onStartup.addListener(loadState);
loadState();
