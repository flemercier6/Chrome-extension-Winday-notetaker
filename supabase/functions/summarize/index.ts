// summarize — sends a meeting's transcript to Gemini (Flash) and stores the
// structured summary (headline, summary, key points, next steps).
//
// Gemini's free/standard tiers return 429 (RESOURCE_EXHAUSTED) under load. We
// retry with exponential backoff and fall back to alternate Flash models so a
// transient rate-limit never loses the meeting.
//
// Backend: writes to the Winday CRM's existing `meetings` table. The plain
// `summary` TEXT column gets the human-readable summary; the full structured
// object (key points, next steps, …) is kept in `metadata.summary` (jsonb).
//
// The Gemini API key lives ONLY here, as the `GEMINI_API_KEY` secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

const responseSchema = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    summary: { type: "STRING" },
    key_points: { type: "ARRAY", items: { type: "STRING" } },
    next_steps: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          task: { type: "STRING" },
          owner: { type: "STRING" },
          priority: { type: "STRING", enum: ["high", "medium", "low"] },
          due: { type: "STRING" },
        },
        required: ["task", "priority"],
      },
    },
    // Identified speakers: which "Participant N" is which known participant.
    // Only confident mappings; [] when unsure.
    speaker_map: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          from: { type: "STRING" },
          to: { type: "STRING" },
        },
        required: ["from", "to"],
      },
    },
  },
  required: ["headline", "summary", "key_points", "next_steps", "speaker_map"],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let persistFail: ((msg: string) => Promise<void>) | null = null;
  try {
    if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY secret is not set." }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { meeting_id, gemini_model, custom_prompt, summary_length } = await req.json();
    // Default to the PINNED model: the "-latest" alias pool saturates (503
    // "high demand") on the free tier while the pinned pool keeps serving.
    const primary = (gemini_model && gemini_model !== "gemini-flash-latest")
      ? gemini_model
      : "gemini-2.5-flash";

    // Persist failures on the meeting row so the CRM (and debugging) can see
    // WHY a summary failed, not just that it did.
    const failMeeting = async (msg: string) => {
      await admin.from("meetings").update({ last_error: msg })
        .eq("id", meeting_id).eq("user_id", user.id);
    };
    persistFail = failMeeting;

    const { data: meeting, error: mErr } = await admin
      .from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).single();
    if (mErr || !meeting) return json({ error: "Meeting not found" }, 404);

    const utterances = meeting.metadata?.transcript?.utterances;
    if (!utterances?.length) {
      const msg = "Meeting has no transcript yet";
      await failMeeting(msg);
      return json({ error: msg }, 400);
    }

    const labelled = utterances.map((u: any) => `${u.speaker}: ${u.text}`).join("\n");

    // Known participants (from enrich-meeting) → let the model identify who the
    // diarized "Participant N" voices actually are, from conversational cues.
    const participants: any[] = meeting.metadata?.participants ?? [];
    const candidateNames = [...new Set(
      participants.filter((p) => !p.is_self && p.name).map((p) => String(p.name)),
    )];
    const speakerInstruction = candidateNames.length
      ? `\n\nKnown participants in this call (besides the user): ${candidateNames.join(", ")}. ` +
        `Using conversational cues (introductions, people addressing each other by name), fill ` +
        `speaker_map with entries mapping diarized labels (e.g. "Participant 1") to one of these ` +
        `exact names — ONLY when you are confident. Leave speaker_map empty otherwise. Never ` +
        `invent names that are not in the list, and never map "You".`
      : `\n\nReturn an empty speaker_map.`;

    // User-customizable instruction (Settings → Summary); structure and speaker
    // identification stay enforced regardless of the custom text.
    const defaultInstruction =
      `You are an expert sales/meeting assistant for Winday CRM. Analyze the ` +
      `following meeting transcript and produce structured notes. The speaker labelled ` +
      `"You" is the app's user; "Participant 1/2/…" are the other attendees. Be concise ` +
      `and action-oriented. For next_steps, infer the owner when possible (the user vs a ` +
      `participant) and assign a realistic priority. Write in the same language as the ` +
      `transcript.`;
    const baseInstruction = (typeof custom_prompt === "string" && custom_prompt.trim())
      ? custom_prompt.trim()
      : defaultInstruction;

    const lengthInstruction = ({
      short: `\n\nLength: SHORT — a 2–3 sentence summary, at most 3 key points, and only ` +
             `the most critical next steps.`,
      medium: ``,
      long: `\n\nLength: LONG — a detailed multi-paragraph summary covering context, ` +
            `discussion and decisions, up to 10 key points, and exhaustive next steps.`,
    } as Record<string, string>)[summary_length ?? "medium"] ?? "";

    const prompt = `${baseInstruction}${lengthInstruction}${speakerInstruction}` +
      `\n\nMeeting title: ${meeting.meeting_title}\n\nTRANSCRIPT:\n${labelled}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
        responseSchema,
        // Explicit ceiling: leaves ample room for a long summary while making
        // MAX_TOKENS truncation detectable instead of producing broken JSON.
        maxOutputTokens: 65536,
      },
    };

    const data = await generateWithRetry(primary, body);
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p?.text ?? "").join("") || null;
    if (!text) {
      const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? "no candidates";
      const msg = `Gemini returned no content (${reason})`;
      await failMeeting(msg);
      return json({ error: msg }, 502);
    }
    let summary: any;
    try {
      summary = JSON.parse(extractJSON(text));
    } catch {
      const msg = `Gemini returned invalid JSON (finishReason: ${candidate?.finishReason ?? "?"})`;
      await failMeeting(msg);
      return json({ error: msg }, 502);
    }

    // Apply confident speaker identifications to the transcript: relabel the
    // diarized "Participant N" utterances with the identified names.
    const speakerMap = new Map<string, string>();
    for (const m of summary.speaker_map ?? []) {
      if (m?.from && m?.to && m.from !== "You" && candidateNames.includes(m.to)) {
        speakerMap.set(m.from, m.to);
      }
    }
    const metadata = { ...(meeting.metadata ?? {}), summary };
    let transcriptText = labelled;
    if (speakerMap.size) {
      const renamed = utterances.map((u: any) => ({
        ...u,
        speaker: speakerMap.get(u.speaker) ?? u.speaker,
      }));
      metadata.transcript = { ...(meeting.metadata?.transcript ?? {}), utterances: renamed };
      transcriptText = renamed.map((u: any) => `${u.speaker}: ${u.text}`).join("\n");
    }

    // Keep meeting_title as recorded (the calendar event's name) — the AI
    // headline lives in metadata.summary.headline for display purposes.
    await admin.from("meetings").update({
      summary: summary.summary ?? "",
      transcript: transcriptText,
      metadata,
      status: "ready",
      last_error: null,
    }).eq("id", meeting_id).eq("user_id", user.id);

    return json({ summary });
  } catch (e) {
    const msg = String(e);
    try { await persistFail?.(msg); } catch { /* best effort */ }
    return json({ error: msg }, 502);
  }
});

/// Gemini occasionally wraps its JSON in markdown fences or leading prose even
/// in JSON mode; extract the outermost object so parsing survives it.
function extractJSON(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/// Calls Gemini with backoff on 429/500/503, then falls back to alternate Flash
/// models. Total worst-case wait ~10s, safely under the function time limit.
async function generateWithRetry(primary: string, body: unknown): Promise<any> {
  // gemini-2.0-flash is intentionally NOT a fallback: its free-tier quota is 0
  // (guaranteed 429). flash-lite runs on separate capacity and often survives
  // "high demand" windows that take down 2.5-flash.
  const fallbacks = ["gemini-2.5-flash", "gemini-2.5-flash-lite"].filter((m) => m !== primary);
  const plan: Array<{ model: string; delay: number }> = [
    { model: primary, delay: 0 },
    ...fallbacks.map((m) => ({ model: m, delay: 1000 })),
    { model: primary, delay: 8000 },
    ...fallbacks.map((m) => ({ model: m, delay: 4000 })),
    { model: primary, delay: 15000 },
  ];

  let lastErr = "unknown error";
  const startedAt = Date.now();
  for (const step of plan) {
    // Long transcripts make each Gemini call slow; stop launching new attempts
    // when there's no time left before the edge-function wall clock kills us.
    if (Date.now() - startedAt > 90_000 && lastErr !== "unknown error") break;
    if (step.delay) await sleep(step.delay);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${step.model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (resp.ok) return await resp.json();

    const status = resp.status;
    lastErr = `${status}: ${(await resp.text()).slice(0, 300)}`;
    // Only worth retrying on rate-limit / transient server errors.
    if (![429, 500, 503].includes(status)) break;
  }
  throw new Error(`Gemini failed after retries — ${lastErr}`);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}
