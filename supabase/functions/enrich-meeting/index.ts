// enrich-meeting — after a recording, work out WHO was in the call and link
// them to the CRM. Two sources, best-effort each:
//
//   1. The calendar event's attendees (Calendar API) — gives EMAILS, which we
//      match to CRM contacts (→ meeting_contacts rows).
//   2. The Google Meet REST API conference record — gives the ACTUAL
//      participants (display names, including people who joined uninvited).
//      Requires the meetings.space.readonly scope; if the stored Google grant
//      predates that scope this step is skipped with meet_api:"reconnect".
//
// Results land in meetings.metadata.participants:
//   [{ name, email?, contact_id?, invited?, joined?, is_self? }]
// The summarize function then uses these names to identify who is speaking in
// the transcript. Failures here never fail the pipeline — the caller ignores
// errors.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

interface Participant {
  name: string;
  email?: string;
  contact_id?: string;
  invited?: boolean;
  joined?: boolean;
  is_self?: boolean;
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { meeting_id } = await req.json();
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: meeting, error: mErr } = await admin
      .from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).single();
    if (mErr || !meeting) return json({ error: "Meeting not found" }, 404);

    const cal = meeting.metadata?.calendar ?? null;
    const meetCode = (meeting.meeting_url ?? "")
      .match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1] ?? null;
    if (!cal?.google_event_id && !meetCode) {
      return json({ skipped: "no calendar/meet context" });
    }

    const { data: account } = await admin
      .from("calendar_accounts").select("*")
      .eq("user_id", user.id).eq("provider", "google").maybeSingle();
    if (!account) return json({ skipped: "no google connection" });

    let accessToken: string;
    try {
      accessToken = await refreshAccessToken(account.refresh_token);
    } catch (_e) {
      return json({ skipped: "google reconnect required" });
    }

    const participants: Participant[] = [];

    const norm = (s: string) =>
      s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    const nameTokens = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

    /// Find who a Meet display name refers to among the invited attendees:
    /// exact (normalized) name match first, then name-tokens ↔ email-local-part
    /// matching ("Gabriel Hardy-Françon" ↔ gabriel@…, "Frederic Lemercier" ↔
    /// lemercier.fred@…). Without this, the same person shows up twice — once
    /// as their invite email, once as their Meet display name.
    const findForName = (name: string): Participant | undefined => {
      const n = norm(name);
      const exact = participants.find((p) => norm(p.name) === n);
      if (exact) return exact;
      const toks = nameTokens(name);
      let best: Participant | undefined;
      let bestScore = 0;
      for (const p of participants) {
        if (!p.email) continue;
        const localParts = norm(p.email.split("@")[0]).split(/[^a-z0-9]+/).filter(Boolean);
        const score = toks.filter((t) =>
          localParts.some((l) => l === t || l.startsWith(t) || t.startsWith(l))).length;
        if (score > bestScore) { best = p; bestScore = score; }
      }
      return bestScore > 0 ? best : undefined;
    };

    // 1) Invited attendees, from the calendar event (emails!).
    if (cal?.google_event_id) {
      const evResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(cal.google_event_id)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (evResp.ok) {
        const event = await evResp.json();
        for (const a of event.attendees ?? []) {
          if (a.resource || !a.email) continue;
          const email = String(a.email).toLowerCase();
          const existing = participants.find((p) => p.email === email);
          if (existing) {
            existing.invited = true;
            existing.is_self = existing.is_self || !!a.self;
            continue;
          }
          participants.push({
            name: a.displayName || email,
            email,
            invited: true,
            is_self: !!a.self,
          });
        }
      }
    }

    // 2) Actual participants, from the Meet REST API conference record.
    let meetApi = "unavailable";
    if (meetCode) {
      const filter = encodeURIComponent(`space.meeting_code = "${meetCode}"`);
      const recResp = await fetch(
        `https://meet.googleapis.com/v2/conferenceRecords?filter=${filter}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (recResp.status === 403) {
        meetApi = "reconnect";   // token predates the meetings.space.readonly scope
      } else if (recResp.ok) {
        const records = (await recResp.json()).conferenceRecords ?? [];
        // Pick the record overlapping this recording (fall back to the latest).
        const startedAt = new Date(meeting.started_at ?? meeting.created_at).getTime();
        const pick = records.find((r: any) => {
          const s = new Date(r.startTime).getTime();
          const e = r.endTime ? new Date(r.endTime).getTime() : Date.now();
          return startedAt >= s - 10 * 60_000 && startedAt <= e + 10 * 60_000;
        }) ?? records[0];
        if (pick) {
          const pResp = await fetch(
            `https://meet.googleapis.com/v2/${pick.name}/participants?pageSize=100`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (pResp.ok) {
            meetApi = "ok";
            for (const p of (await pResp.json()).participants ?? []) {
              const name = p.signedinUser?.displayName
                ?? p.anonymousUser?.displayName
                ?? p.phoneUser?.displayName;
              if (!name) continue;
              const existing = findForName(name);
              if (existing) {
                existing.joined = true;
                // Upgrade an email-as-name entry to the real display name.
                if (!existing.name || existing.name === existing.email) existing.name = name;
              } else {
                participants.push({ name, joined: true });
              }
            }
          }
        } else {
          meetApi = "no_record";
        }
      }
    }

    // 3) Match emails to CRM contacts and link them to the meeting.
    const emails = participants.map((p) => p.email).filter(Boolean) as string[];
    if (emails.length) {
      const { data: contacts } = await userClient
        .from("contacts").select("id, email").in("email", emails);
      const byEmail = new Map((contacts ?? []).map((c: any) => [String(c.email).toLowerCase(), c.id]));
      for (const p of participants) {
        if (p.email && byEmail.has(p.email)) p.contact_id = byEmail.get(p.email);
      }

      const ids = participants.map((p) => p.contact_id).filter(Boolean) as string[];
      if (ids.length) {
        const { data: existing } = await userClient
          .from("meeting_contacts").select("contact_id").eq("meeting_id", meeting_id);
        const already = new Set((existing ?? []).map((r: any) => r.contact_id));
        const rows = ids.filter((id) => !already.has(id))
          .map((id) => ({ meeting_id, contact_id: id, user_id: user.id }));
        if (rows.length) await userClient.from("meeting_contacts").insert(rows);
      }
    }

    const metadata = { ...(meeting.metadata ?? {}), participants };
    await admin.from("meetings").update({ metadata }).eq("id", meeting_id).eq("user_id", user.id);

    return json({ participants, meet_api: meetApi });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}
