// transcribe-stream — live transcription relay for the Chrome extension.
//
// A browser can't hold the Deepgram key, so the extension opens a WebSocket
// HERE and we proxy it to Deepgram's live API with the server-side key. Flow:
//   browser  --(PCM audio)-->  this function  --(audio)-->  Deepgram live
//   browser  <--(transcripts)--  this function  <--(JSON)--  Deepgram live
//
// Auth: browsers can't set headers on a WebSocket, so the Supabase user JWT is
// passed as the `token` query param (validated below) and the anon key as
// `apikey` (authorizes the gateway — same pattern Supabase Realtime uses).
// Deployed with verify_jwt=false because the check happens here, not at the
// gateway. The DEEPGRAM_API_KEY secret is the same one `transcribe` uses.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY") ?? "";

Deno.serve(async (req) => {
  if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }
  if (!DEEPGRAM_API_KEY) return new Response("DEEPGRAM_API_KEY is not set.", { status: 500 });

  const url = new URL(req.url);
  const q = url.searchParams;

  // Authenticate the Supabase user before upgrading.
  const token = q.get("token") ?? "";
  const { data: { user } } = await createClient(SUPABASE_URL, ANON_KEY).auth.getUser(token);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { socket: client, response } = Deno.upgradeWebSocket(req);
  client.binaryType = "arraybuffer";

  // Deepgram live URL, built from the client's audio params. nova-3 + the
  // formatting flags requested for the extension.
  const channels = q.get("channels") || "2";
  const dg = new URL("wss://api.deepgram.com/v1/listen");
  const dgParams: Record<string, string> = {
    model: q.get("model") || "nova-3",
    // Streaming has no language auto-detect — without this it defaults to
    // English. "multi" is Nova-3's real-time code-switching mode (EN/FR/ES/DE/
    // HI/RU/PT/JA/IT/NL); a specific BCP-47 tag pins one language.
    language: q.get("language") || "multi",
    encoding: "linear16",
    sample_rate: q.get("sample_rate") || "48000",
    channels,
    diarize: "true",
    punctuate: "true",
    numerals: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
  };
  if (channels === "2") dgParams.multichannel = "true";
  for (const [k, v] of Object.entries(dgParams)) dg.searchParams.set(k, v);

  let deepgram: WebSocket | null = null;
  let dgReady = false;
  const pending: (ArrayBuffer | string)[] = [];
  let keepAlive: number | undefined;

  const closeBoth = () => {
    clearInterval(keepAlive);
    try { deepgram && deepgram.readyState <= 1 && deepgram.close(); } catch (_) { /* noop */ }
    try { client.readyState <= 1 && client.close(); } catch (_) { /* noop */ }
  };

  client.onopen = () => {
    deepgram = new WebSocket(dg.toString(), ["token", DEEPGRAM_API_KEY]);
    deepgram.binaryType = "arraybuffer";
    deepgram.onopen = () => {
      dgReady = true;
      for (const m of pending) { try { deepgram!.send(m as ArrayBuffer); } catch (_) { /* noop */ } }
      pending.length = 0;
      // Deepgram closes an idle stream after ~10s; nudge it during silence.
      keepAlive = setInterval(() => {
        try { deepgram?.readyState === 1 && deepgram.send(JSON.stringify({ type: "KeepAlive" })); } catch (_) { /* noop */ }
      }, 8000);
    };
    // Forward Deepgram's JSON results straight through to the browser.
    deepgram.onmessage = (e) => { try { client.readyState === 1 && client.send(e.data); } catch (_) { /* noop */ } };
    deepgram.onclose = closeBoth;
    deepgram.onerror = closeBoth;
  };

  client.onmessage = (e) => {
    const data = e.data as ArrayBuffer | string;
    if (!dgReady || !deepgram) { pending.push(data); return; }
    try { deepgram.send(data as ArrayBuffer); } catch (_) { /* noop */ }
  };
  client.onclose = () => {
    clearInterval(keepAlive);
    // Tell Deepgram to flush the last words, then close.
    try {
      if (deepgram && deepgram.readyState === 1) {
        deepgram.send(JSON.stringify({ type: "CloseStream" }));
        setTimeout(() => { try { deepgram?.close(); } catch (_) { /* noop */ } }, 500);
      } else { deepgram?.close(); }
    } catch (_) { /* noop */ }
  };
  client.onerror = closeBoth;

  return response;
});
