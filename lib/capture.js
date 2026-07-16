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

/** One-shot mic permission probe, for an "Allow microphone" button: shows
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

/** One recording session: start(streams) -> stop()/cancel() -> pipeline.
 *  Alongside the MediaRecorder it streams the live audio to Deepgram (via the
 *  transcribe-stream relay) for an on-screen transcript, and meters the mix for
 *  the sound visualizer. The streamed FINAL utterances become the saved
 *  transcript; if streaming produced nothing, finalize falls back to the batch
 *  transcription pipeline. */
export function createRecorder() {
  let mediaRecorder = null;
  let chunks = [];
  let audioContext = null;
  let streams = [];
  let meeting = null;
  let settings = null;
  let cancelled = false;

  // Live layer.
  let onEvent = null;          // local sink (used when the panel hosts recording)
  let ws = null;               // WebSocket to transcribe-stream
  let wsOpen = false;
  let outbox = [];             // audio frames queued until the WS opens
  let worklet = null;          // AudioWorkletNode pumping PCM
  let analyser = null;         // for the visualizer
  let meterTimer = null;
  let liveUtterances = [];     // accumulated FINAL utterances -> saved transcript
  let dgLanguage = null;

  // report() reaches other contexts (SW + any open panel) over runtime
  // messaging; onEvent also delivers to THIS context (a context can't receive
  // its own runtime messages, so the panel host needs the local copy).
  function emit(msg) {
    report(msg);
    if (onEvent) { try { onEvent(msg); } catch (_) {} }
  }

  async function start(opts) {
    // opts: { tabStream, micStream, monitorTab, meeting, session, settings, onEvent? }
    configureSession(opts.session);
    settings = opts.settings;
    onEvent = opts.onEvent || null;
    meeting = { ...opts.meeting, status: "recording" };
    liveUtterances = [];
    dgLanguage = null;
    emit({ type: "WN_MEETING_UPSERT", meeting });

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
    emit({ type: "WN_REC_STARTED" });

    // Live transcript + visualizer — best-effort. Any failure leaves recording
    // untouched; finalize() falls back to the batch transcription.
    startMetering(merger);
    startStreaming(merger).catch((e) => emit({ type: "WN_TRANSCRIPT_ERROR", error: String(e?.message || e) }));
  }

  // --- Live streaming -----------------------------------------------------

  async function startStreaming(merger) {
    const url = await sb.functionWsURL("transcribe-stream", {
      sample_rate: Math.round(audioContext.sampleRate),
      channels: 2,
      model: (settings && settings.deepgramModel) || "nova-3",
    });
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsOpen = false;
    outbox = [];
    ws.onopen = () => {
      wsOpen = true;
      for (const b of outbox) { try { ws.send(b); } catch (_) {} }
      outbox = [];
    };
    ws.onmessage = (e) => { try { handleDg(JSON.parse(e.data)); } catch (_) {} };
    ws.onerror = () => {};
    ws.onclose = () => { wsOpen = false; };

    await audioContext.audioWorklet.addModule(chrome.runtime.getURL("lib/pcm-worklet.js"));
    worklet = new AudioWorkletNode(audioContext, "pcm-extractor", {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit",
    });
    worklet.port.onmessage = (e) => {
      const buf = e.data;
      if (!ws) return;
      if (wsOpen && ws.readyState === WebSocket.OPEN) { try { ws.send(buf); } catch (_) {} }
      else if (outbox.length < 250) outbox.push(buf); // ~10s of audio, then drop
    };
    merger.connect(worklet);
  }

  // Deepgram live result -> transcript event (+ accumulate finals).
  function handleDg(msg) {
    if (!msg || !msg.channel) return;
    const alt = msg.channel.alternatives && msg.channel.alternatives[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    const chIndex = Array.isArray(msg.channel_index) ? (msg.channel_index[0] || 0) : 0;
    const isFinal = !!msg.is_final;
    const spk = alt.words && alt.words[0] && typeof alt.words[0].speaker === "number" ? alt.words[0].speaker : 0;
    const speaker = chIndex === 0 ? "You" : `Participant ${spk + 1}`;
    const start = msg.start ?? 0;
    const end = start + (msg.duration ?? 0);
    if (msg.channel.detected_language && !dgLanguage) dgLanguage = msg.channel.detected_language;
    emit({ type: "WN_TRANSCRIPT", channel: chIndex, speaker, text, isFinal, start, end });
    if (isFinal) liveUtterances.push({ speaker, text, start, end });
  }

  // --- Visualizer metering ------------------------------------------------

  function startMetering(merger) {
    try {
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;
      merger.connect(analyser);
      const bins = analyser.frequencyBinCount; // 64
      const data = new Uint8Array(bins);
      const BARS = 24;
      const per = Math.max(1, Math.floor(bins / BARS));
      meterTimer = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const bars = new Array(BARS);
        for (let i = 0; i < BARS; i++) {
          let sum = 0;
          for (let j = 0; j < per; j++) sum += data[i * per + j] || 0;
          bars[i] = Math.round((sum / per) / 255 * 100) / 100; // 0..1
        }
        emit({ type: "WN_REC_LEVEL", bars });
      }, 60);
    } catch (_) { /* visualizer is optional */ }
  }

  // Stop feeding audio to the live layer (but keep the WS briefly for the tail).
  function stopStreamingInput() {
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    if (worklet) { try { worklet.port.onmessage = null; worklet.disconnect(); } catch (_) {} worklet = null; }
  }

  function buildTranscript() {
    const utts = dedupeEcho(liveUtterances.slice().sort((a, b) => a.start - b.start));
    return { fullText: utts.map((u) => u.text).join(" "), utterances: utts, language: dgLanguage };
  }

  // Drop "You" utterances that echo a time-overlapping participant (the mic
  // picking the call back up through the speakers). Mirrors the batch pass.
  function dedupeEcho(utts) {
    const toks = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    const parts = utts.filter((u) => u.speaker !== "You");
    const isEcho = (you) => {
      const yt = toks(you.text);
      if (!yt.length) return false;
      for (const p of parts) {
        if (p.end < you.start - 2 || p.start > you.end + 2) continue;
        const pt = new Set(toks(p.text));
        if (yt.filter((w) => pt.has(w)).length / yt.length >= 0.7) return true;
      }
      return false;
    };
    return utts.filter((u) => u.speaker !== "You" || !isEcho(u));
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
    stopStreamingInput();
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    wsOpen = false;
    outbox = [];
    analyser = null;
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

    // Stop sending audio; ask Deepgram to flush its buffered tail, then give the
    // last finals a moment to arrive before we tear the WebSocket down.
    stopStreamingInput();
    if (!wasCancelled && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "Finalize" })); } catch (_) {}
      await new Promise((r) => setTimeout(r, 700));
    }
    teardown();

    if (wasCancelled || !m) {
      if (m) emit({ type: "WN_MEETING_REMOVE", id: m.id });
      return;
    }

    const blob = new Blob(localChunks, { type: "audio/webm" });
    m.endedAt = new Date().toISOString();
    m.status = "recorded";
    emit({ type: "WN_MEETING_UPSERT", meeting: m });

    if (blob.size === 0) {
      const failed = { ...m, status: "failed", errorMessage: "The recording was empty — no audio was captured." };
      emit({ type: "WN_MEETING_UPSERT", meeting: failed });
      emit({ type: "WN_REC_FAILED", error: failed.errorMessage });
      return;
    }

    try {
      const opts = { settings, onStage: (stage) => emit({ type: "WN_REC_STAGE", stage }) };
      const transcript = buildTranscript();
      // Live transcript is authoritative; fall back to the batch pass only if
      // streaming produced nothing (WS blocked, no speech captured, …).
      const result = transcript.utterances.length > 0
        ? await pipeline.processLive(blob, m, transcript, opts)
        : await pipeline.process(blob, m, opts);
      emit({ type: "WN_MEETING_UPSERT", meeting: result });
      if (result.errorMessage) emit({ type: "WN_REC_FAILED", error: result.errorMessage });
      else emit({ type: "WN_REC_DONE", notionURL: result.notionPageURL || null, meetingId: result.id });
    } catch (e) {
      const failed = { ...m, status: "failed", errorMessage: String(e?.message || e) };
      emit({ type: "WN_MEETING_UPSERT", meeting: failed });
      emit({ type: "WN_REC_FAILED", error: failed.errorMessage });
    }
  }

  /** Abort a start() that failed before the recorder began. */
  function failNow(e) {
    teardown();
    const err = String(e?.message || e);
    if (meeting) {
      const failed = { ...meeting, status: "failed", errorMessage: err };
      meeting = null;
      emit({ type: "WN_MEETING_UPSERT", meeting: failed });
    }
    emit({ type: "WN_REC_FAILED", error: err });
  }

  return { start, stop, isActive, failNow };
}
