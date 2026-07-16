// The recording + processing worker. Runs inside an offscreen document (a
// persistent page context) so it survives service-worker suspension for the
// whole multi-minute pipeline.
//
// Capture model (mirrors the macOS app's two-channel WAV): the mixed recording
// is STEREO where the LEFT channel is your microphone ("You") and the RIGHT
// channel is the meeting tab audio (the other participants). transcribe runs
// Deepgram with multichannel=true, so channel 0 = "You" and channel 1 = the
// others — exactly what the shared backend expects.
import * as store from "./lib/store.js";
import * as pipeline from "./lib/pipeline.js";

let mediaRecorder = null;
let chunks = [];
let audioContext = null;
let tabStream = null;
let micStream = null;
let destStream = null;
let currentMeeting = null;

function report(message) {
  // Fire-and-forget to the service worker (which mirrors it to the UI).
  chrome.runtime.sendMessage(message).catch(() => {});
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
      retryMeeting(msg.meetingId).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
      break;
    case "EXPORT":
      exportMeeting(msg.meetingId).catch((e) => report({ type: "WN_REC_FAILED", error: String(e?.message || e) }));
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

async function startRecording({ streamId, meeting, settings }) {
  currentMeeting = { ...meeting, status: "recording" };
  await store.upsertMeeting(currentMeeting);

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
    await store.setMicGranted(true);
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

let cancelled = false;

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
    if (meeting) await store.removeMeeting(meeting.id);
    return;
  }

  const blob = new Blob(localChunks, { type: "audio/webm" });
  meeting.endedAt = new Date().toISOString();
  meeting.status = "recorded";
  await store.upsertMeeting(meeting);

  if (blob.size === 0) {
    meeting.status = "failed";
    meeting.errorMessage = "The recording was empty — no audio was captured.";
    await store.upsertMeeting(meeting);
    report({ type: "WN_REC_FAILED", error: meeting.errorMessage });
    return;
  }

  await runPipeline(blob, meeting);
}

async function runPipeline(blob, meeting) {
  const settings = await store.getSettings();
  try {
    const result = await pipeline.process(blob, meeting, {
      settings,
      onStage: (stage) => report({ type: "WN_REC_STAGE", stage }),
    });
    await store.upsertMeeting(result);
    if (result.errorMessage) {
      report({ type: "WN_REC_FAILED", error: result.errorMessage });
    } else {
      report({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
    }
  } catch (e) {
    const failed = { ...meeting, status: "failed", errorMessage: String(e?.message || e) };
    await store.upsertMeeting(failed);
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
  }
}

async function retryMeeting(id) {
  const meetings = await store.getMeetings();
  const meeting = meetings.find((m) => m.id === id);
  if (!meeting) throw new Error("Meeting not found.");
  const settings = await store.getSettings();
  try {
    const result = await pipeline.retry(meeting, {
      settings,
      onStage: (stage) => report({ type: "WN_REC_STAGE", stage }),
    });
    await store.upsertMeeting(result);
    report({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
  } catch (e) {
    const failed = { ...meeting, status: "failed", errorMessage: String(e?.message || e) };
    await store.upsertMeeting(failed);
    report({ type: "WN_REC_FAILED", error: failed.errorMessage });
  }
}

async function exportMeeting(id) {
  const meetings = await store.getMeetings();
  const meeting = meetings.find((m) => m.id === id);
  if (!meeting || !meeting.summary) throw new Error("Nothing to export yet.");
  const settings = await store.getSettings();
  report({ type: "WN_REC_STAGE", stage: "exporting" });
  try {
    const url = await pipeline.exportToNotion(meeting, settings);
    const updated = { ...meeting, notionPageURL: url, status: "exported", errorMessage: null };
    await store.upsertMeeting(updated);
    report({ type: "WN_REC_DONE", notionURL: url, meetingId: id });
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
    store.upsertMeeting(failed);
  }
  report({ type: "WN_REC_FAILED", error: err });
}
