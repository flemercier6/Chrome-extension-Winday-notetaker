// Shared recording engine, used by BOTH recording hosts:
//   - the offscreen document — silent tabCapture path (survives tab close);
//   - the panel iframe embedded in the Meet tab — getDisplayMedia fallback,
//     used when Chromium refuses silent capture (no activeTab grant). That
//     API is the same one Meet itself uses for screen sharing, so it exists
//     in every Chromium — including Arc, which lacks the extension picker.
//
// The engine mixes the meeting audio (RIGHT channel) with the microphone
// (LEFT channel) into a stereo webm/opus MediaRecorder, then runs the
// upload → transcribe → summarize → export pipeline, reporting progress with
// the WN_* runtime protocol that the service worker mirrors to every surface.
import * as pipeline from "./pipeline.js";
import * as sb from "./supabase.js";

export function report(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

/** Configure the REST client's session; token refreshes are relayed to the
 *  service worker, which owns chrome.storage persistence. */
export function configureSession(session) {
  sb.useSession(session, (s) => report({ type: "WN_SESSION_REFRESHED", session: s }));
}

/** Microphone (your side) — best-effort; callers record meeting-only without it. */
export async function acquireMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    report({ type: "WN_MIC_GRANTED" });
    return s;
  } catch (_) {
    return null;
  }
}

/** One-shot mic permission probe, for a "Autoriser le microphone" button: shows
 *  the browser's permission prompt right where the user is (no navigation to a
 *  separate settings page needed — that page-hop is what got users stuck when
 *  chrome.runtime.openOptionsPage() no-ops on some Chromium forks), releases
 *  the device immediately, and reports success so every open surface can drop
 *  the "mic not enabled" banner. Rejects with the browser's denial reason. */
export async function requestMicPermission() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  report({ type: "WN_MIC_GRANTED" });
}

export function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "audio/webm";
}

/** One recording session: start(streams) -> stop()/cancel() -> pipeline. */
export function createRecorder() {
  let mediaRecorder = null;
  let chunks = [];
  let audioContext = null;
  let streams = [];
  let meeting = null;
  let settings = null;
  let cancelled = false;

  async function start(opts) {
    // opts: { tabStream, micStream, monitorTab, meeting, session, settings }
    configureSession(opts.session);
    settings = opts.settings;
    meeting = { ...opts.meeting, status: "recording" };
    report({ type: "WN_MEETING_UPSERT", meeting });

    streams = [opts.tabStream, opts.micStream].filter(Boolean);
    audioContext = new AudioContext();
    const merger = audioContext.createChannelMerger(2);
    if (opts.micStream) {
      audioContext.createMediaStreamSource(opts.micStream).connect(merger, 0, 0);
    }
    const tabSource = audioContext.createMediaStreamSource(opts.tabStream);
    tabSource.connect(merger, 0, 1);
    if (opts.monitorTab) {
      // tabCapture silences the tab's own playback; route it to the speakers
      // so the call stays audible. (getDisplayMedia keeps local playback —
      // routing it again would double the audio.)
      tabSource.connect(audioContext.destination);
    }
    const dest = audioContext.createMediaStreamDestination();
    merger.connect(dest);
    streams.push(dest.stream);

    chunks = [];
    cancelled = false;
    mediaRecorder = new MediaRecorder(dest.stream, { mimeType: pickMimeType() });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => finalize();
    mediaRecorder.start(1000);
    report({ type: "WN_REC_STARTED" });
  }

  function stop(isCancel) {
    cancelled = !!isCancel;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop(); // -> onstop -> finalize
    } else {
      teardown();
    }
  }

  function isActive() {
    return !!mediaRecorder && mediaRecorder.state !== "inactive";
  }

  function teardown() {
    for (const s of streams) {
      try { s.getTracks().forEach((t) => t.stop()); } catch (_) {}
    }
    streams = [];
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    mediaRecorder = null;
  }

  async function finalize() {
    const localChunks = chunks;
    chunks = [];
    const m = meeting;
    meeting = null;
    const wasCancelled = cancelled;
    cancelled = false;
    teardown();

    if (wasCancelled || !m) {
      if (m) report({ type: "WN_MEETING_REMOVE", id: m.id });
      return;
    }

    const blob = new Blob(localChunks, { type: "audio/webm" });
    m.endedAt = new Date().toISOString();
    m.status = "recorded";
    report({ type: "WN_MEETING_UPSERT", meeting: m });

    if (blob.size === 0) {
      const failed = { ...m, status: "failed", errorMessage: "The recording was empty — no audio was captured." };
      report({ type: "WN_MEETING_UPSERT", meeting: failed });
      report({ type: "WN_REC_FAILED", error: failed.errorMessage });
      return;
    }

    try {
      const result = await pipeline.process(blob, m, {
        settings,
        onStage: (stage) => report({ type: "WN_REC_STAGE", stage }),
      });
      report({ type: "WN_MEETING_UPSERT", meeting: result });
      if (result.errorMessage) report({ type: "WN_REC_FAILED", error: result.errorMessage });
      else report({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
    } catch (e) {
      const failed = { ...m, status: "failed", errorMessage: String(e?.message || e) };
      report({ type: "WN_MEETING_UPSERT", meeting: failed });
      report({ type: "WN_REC_FAILED", error: failed.errorMessage });
    }
  }

  /** Abort a start() that failed before the recorder began. */
  function failNow(e) {
    teardown();
    const err = String(e?.message || e);
    if (meeting) {
      const failed = { ...meeting, status: "failed", errorMessage: err };
      meeting = null;
      report({ type: "WN_MEETING_UPSERT", meeting: failed });
    }
    report({ type: "WN_REC_FAILED", error: err });
  }

  return { start, stop, isActive, failNow };
}
