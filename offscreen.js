// The recording + processing worker. Runs inside an offscreen document (a
// persistent page context) so it survives service-worker suspension for the
// whole multi-minute pipeline.
//
// Offscreen documents have NO access to chrome.storage — only chrome.runtime
// messaging. So this worker is stateless w.r.t. storage: the background hands it
// the session + settings + meeting in each message, it does capture + fetch
// only, and it reports every persistable change back to the background (which
// owns chrome.storage).
//
// Capture model (mirrors the macOS app's two-channel WAV): the mixed recording
// is STEREO where the LEFT channel is your microphone ("You") and the RIGHT
// channel is the meeting tab audio (the other participants). transcribe runs
// Deepgram with multichannel=true, so channel 0 = "You" and channel 1 = the
// others — exactly what the shared backend expects.
import * as pipeline from "./lib/pipeline.js";
import * as sb from "./lib/supabase.js";

let mediaRecorder = null;
let chunks = [];
let audioContext = null;
let tabStream = null;
let micStream = null;
let destStream = null;
let currentMeeting = null;
let currentSettings = null;
let cancelled = false;

function report(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Configure the REST client's session and mirror any token refresh back to the
// background so it gets persisted to chrome.storage.
function configureSession(session) {
  sb.useSession(session, (s) => report({ type: "WN_SESSION_REFRESHED", session: s }));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  switch (msg.type) {
    case "START":
      startRecording(msg).catch((e) => failNow(e));
      break;
    case "STOP":
      stopRecording(false);
      break;
    case "CANCEL":
      stopRecording(true);
      break;
    case "RETRY":
      retryMeeting(msg).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
    case "EXPORT":
      exportMeeting(msg).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
  }
});

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "audio/webm";
}

async function startRecording({ streamId, meeting, session, settings }) {
  configureSession(session);
  currentSettings = settings;
  currentMeeting = { ...meeting, status: "recording" };
  report({ type: "WN_MEETING_UPSERT", meeting: currentMeeting });

  // 1) Tab audio (the remote participants).
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: false,
  });

  // 2) Microphone (your side) — best-effort; record tab-only if unavailable.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    report({ type: "WN_MIC_GRANTED" });
  } catch (_) {
    micStream = null;
  }

  // 3) Mix into a 2-channel stream: L = mic ("You"), R = tab (the others).
  audioContext = new AudioContext();
  const merger = audioContext.createChannelMerger(2);
  if (micStream) {
    audioContext.createMediaStreamSource(micStream).connect(merger, 0, 0);
  }
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(merger, 0, 1);
  // Capturing a tab's audio silences its normal playback; route it to the
  // speakers so you still HEAR the call while it records.
  tabSource.connect(audioContext.destination);

  const dest = audioContext.createMediaStreamDestination();
  merger.connect(dest);
  destStream = dest.stream;

  // 4) Record.
  chunks = [];
  mediaRecorder = new MediaRecorder(destStream, { mimeType: pickMimeType() });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = () => finalizeRecording();
  mediaRecorder.start(1000); // gather ~1s chunks

  report({ type: "WN_REC_STARTED" });
}

function stopRecording(isCancel) {
  cancelled = isCancel;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop(); // triggers onstop -> finalizeRecording
  } else {
    teardownStreams();
  }
}

function teardownStreams() {
  for (const s of [tabStream, micStream, destStream]) {
    if (s) s.getTracks().forEach((t) => t.stop());
  }
  tabStream = micStream = destStream = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

async function finalizeRecording() {
  const localChunks = chunks;
  chunks = [];
  const meeting = currentMeeting;
  currentMeeting = null;
  const wasCancelled = cancelled;
  cancelled = false;

  teardownStreams();

  if (wasCancelled || !meeting) {
    if (meeting) report({ type: "WN_MEETING_REMOVE", id: meeting.id });
    return;
  }

  const blob = new Blob(localChunks, { type: "audio/webm" });
  meeting.endedAt = new Date().toISOString();
  meeting.status = "recorded";
  report({ type: "WN_MEETING_UPSERT", meeting });

  if (blob.size === 0) {
    const failed = { ...meeting, status: "failed", errorMessage: "The recording was empty — no audio was captured." };
    report({ type: "WN_MEETING_UPSERT", meeting: failed });
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
    return;
  }

  try {
    const result = await pipeline.process(blob, meeting, {
      settings: currentSettings,
      onStage: (stage) => report({ type: "WN_REC_STAGE", stage }),
    });
    report({ type: "WN_MEETING_UPSERT", meeting: result });
    if (result.errorMessage) report({ type: "WN_REC_FAILED", error: result.errorMessage });
    else report({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
  } catch (e) {
    const failed = { ...meeting, status: "failed", errorMessage: String(e?.message || e) };
    report({ type: "WN_MEETING_UPSERT", meeting: failed });
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
  }
}

async function retryMeeting({ meeting, session, settings }) {
  if (!meeting) throw new Error("Meeting not found.");
  configureSession(session);
  try {
    const result = await pipeline.retry(meeting, {
      settings,
      onStage: (stage) => report({ type: "WN_REC_STAGE", stage }),
    });
    report({ type: "WN_MEETING_UPSERT", meeting: result });
    report({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
  } catch (e) {
    const failed = { ...meeting, status: "failed", errorMessage: String(e?.message || e) };
    report({ type: "WN_MEETING_UPSERT", meeting: failed });
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
  }
}

async function exportMeeting({ meeting, session, settings }) {
  if (!meeting || !meeting.summary) throw new Error("Nothing to export yet.");
  configureSession(session);
  report({ type: "WN_REC_STAGE", stage: "exporting" });
  try {
    const url = await pipeline.exportToNotion(meeting, settings);
    const updated = { ...meeting, notionPageURL: url, status: "exported", errorMessage: null };
    report({ type: "WN_MEETING_UPSERT", meeting: updated });
    report({ type: "WN_REC_DONE", notionURL: url, meetingId: meeting.id });
  } catch (e) {
    report({ type: "WN_REC_FAILED", error: String(e?.message || e) });
  }
}

function failNow(e) {
  teardownStreams();
  const err = String(e?.message || e);
  if (currentMeeting) {
    const failed = { ...currentMeeting, status: "failed", errorMessage: err };
    currentMeeting = null;
    report({ type: "WN_MEETING_UPSERT", meeting: failed });
  }
  report({ type: "WN_REC_FAILED", error: err });
}
