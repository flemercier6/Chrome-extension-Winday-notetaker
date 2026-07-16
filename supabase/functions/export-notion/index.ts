// export-notion — creates a Notion page (a new row in a database) from a
// meeting's summary.
//
// Title  = "<event title> | <date chip> | <time>"  where the date is a real
//          Notion date mention (renders like an @today chip, set to the meeting
//          date). Falls back to plain text if the database rejects mentions in
//          the title.
// Body   = the AI summary (summary, key points, prioritized next steps).
//
// Backend: reads the structured summary from the Winday CRM `meetings` table's
// `metadata.summary` (jsonb) and records the resulting Notion URL back into
// `metadata.notion_page_url`. The target database id is supplied per request by
// the caller (a non-secret user preference), so no server-side settings table is
// needed.
//
// The Notion integration token lives ONLY here, as the `NOTION_TOKEN` secret.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN") ?? "";
const NOTION_VERSION = "2022-06-28";
const TZ = "Europe/Paris";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    if (!NOTION_TOKEN) return json({ error: "NOTION_TOKEN secret is not set." }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { meeting_id, notion_database_id } = await req.json();

    const databaseId = notion_database_id;
    if (!databaseId) return json({ error: "No Notion database configured in Settings" }, 400);

    const { data: meeting, error: mErr } = await admin
      .from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).single();
    if (mErr || !meeting) return json({ error: "Meeting not found" }, 404);

    const summary = meeting.metadata?.summary;
    if (!summary) return json({ error: "Meeting has no summary to export" }, 400);

    // Try with a date-mention title; if Notion rejects it, retry with plain text.
    let resp = await postPage(buildPage(databaseId, meeting, summary, true));
    if (!resp.ok) {
      resp = await postPage(buildPage(databaseId, meeting, summary, false));
    }
    if (!resp.ok) return json({ error: `Notion ${resp.status}: ${await resp.text()}` }, 502);

    const page = await resp.json();
    const metadata = { ...(meeting.metadata ?? {}), notion_page_url: page.url };
    await admin.from("meetings").update({
      metadata, status: "exported",
    }).eq("id", meeting_id).eq("user_id", user.id);

    return json({ url: page.url });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function postPage(body: unknown) {
  return fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function buildPage(databaseId: string, meeting: any, s: any, useDateMention: boolean) {
  const emoji: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };
  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const rt = (t: string) => [{ type: "text", text: { content: String(t).slice(0, 1990) } }];

  // Notion page title = the event's name (as recorded), never the AI headline.
  const eventTitle = meeting.meeting_title || "Meeting";
  const started = new Date(meeting.started_at ?? meeting.created_at);
  const dateISO = started.toLocaleDateString("en-CA", { timeZone: TZ });        // YYYY-MM-DD
  const dateLong = started.toLocaleDateString("fr-FR", {
    day: "numeric", month: "long", year: "numeric", timeZone: TZ,
  });
  const timeStr = started.toLocaleTimeString("fr-FR", {
    hour: "2-digit", minute: "2-digit", timeZone: TZ,
  });

  // Title: "<event> | <date> | <time>". The date is a Notion date mention when
  // allowed (renders as an @today-style chip), otherwise plain text.
  const title = useDateMention
    ? [
        { type: "text", text: { content: `${eventTitle} | ` } },
        { type: "mention", mention: { type: "date", date: { start: dateISO } } },
        { type: "text", text: { content: ` | ${timeStr}` } },
      ]
    : rt(`${eventTitle} | ${dateLong} | ${timeStr}`);

  // Body = the AI summary.
  const children: any[] = [
    { object: "block", type: "paragraph", paragraph: { rich_text: rt(s.summary ?? "") } },
  ];

  if (Array.isArray(s.key_points) && s.key_points.length) {
    children.push({ object: "block", type: "heading_3", heading_3: { rich_text: rt("Key points") } });
    for (const p of s.key_points) {
      children.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(p) } });
    }
  }

  if (Array.isArray(s.next_steps) && s.next_steps.length) {
    children.push({ object: "block", type: "heading_3", heading_3: { rich_text: rt("Next steps & priorities") } });
    const steps = [...s.next_steps].sort((a, b) => (order[a.priority] ?? 9) - (order[b.priority] ?? 9));
    for (const step of steps) {
      const parts = [`${emoji[step.priority] ?? ""} ${step.task}`];
      if (step.owner) parts.push(`— ${step.owner}`);
      if (step.due) parts.push(`(${step.due})`);
      children.push({
        object: "block", type: "to_do",
        to_do: { rich_text: rt(parts.join(" ")), checked: false },
      });
    }
  }

  return {
    parent: { database_id: databaseId },
    properties: { title: { title } },
    children,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}
