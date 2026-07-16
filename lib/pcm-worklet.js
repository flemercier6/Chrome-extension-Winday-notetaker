// AudioWorklet: taps the merged stereo bus (channel 0 = you/mic, channel 1 =
// the meeting) and emits interleaved 16-bit PCM (linear16) frames of ~40ms,
// which the recorder streams to Deepgram's live API. Registered as
// "pcm-extractor". Runs off the main thread so it never stalls the UI.
class PCMExtractor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._acc = []; // interleaved Int16 samples awaiting a post
    this._frame = 2048; // samples PER CHANNEL per post (~43ms @ 48kHz)
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const l = input[0];
    const r = input[1] || input[0]; // mono source -> duplicate into both channels
    const n = l ? l.length : 0;
    for (let i = 0; i < n; i++) {
      this._acc.push(toInt16(l[i]), toInt16(r[i]));
    }
    if (this._acc.length >= this._frame * 2) {
      const out = new Int16Array(this._acc);
      this._acc.length = 0;
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}

function toInt16(x) {
  const s = x < -1 ? -1 : x > 1 ? 1 : x;
  return s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
}

registerProcessor("pcm-extractor", PCMExtractor);
