// notion-oauth — per-user Notion OAuth (public integration) for Winday Meet.
//
// Replaces the "paste a database ID + shared internal token" model with a real
// per-user connection: the user authorises their own Notion workspace, we get a
// token scoped to what they granted, and a "Winday Meeting Notes" database is
// provisioned automatically (either a duplicated template — the recommended
// setup — or created programmatically under a granted page). Every meeting note
// then lands in that database with no ID to copy.
//
// Endpoints (single function, routed by path/action):
//   GET/POST ?action=start       (auth)   -> { url }   authorize URL to open
//   GET      /notion-oauth/callback (public) Notion redirects here with ?code&state
//   GET/POST ?action=status      (auth)   -> { connected, workspace_name, ... }
//   POST     ?action=disconnect  (auth)   -> { ok: true }
//
// Secrets (set once in Supabase): NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET.
// The client_secret + every user access_token stay server-side only.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("NOTION_OAUTH_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("NOTION_OAUTH_CLIENT_SECRET") ?? "";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/notion-oauth/callback`;
const NOTION_VERSION = "2022-06-28";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = new URL(req.url);
  const action = url.pathname.endsWith("/callback") ? "callback" : (url.searchParams.get("action") ?? "");

  try {
    if (action === "callback") return await handleCallback(url);
    if (!CLIENT_ID || !CLIENT_SECRET)
      return json({ error: "Notion OAuth is not configured (missing client id/secret secret)." }, 500);

    const user = await getUser(req);
    if (!user) return json({ error: "Unauthorized" }, 401);

    if (action === "start") return await handleStart(user.id);
    if (action === "status") return json(await statusFor(user.id));
    if (action === "disconnect") {
      await admin.from("notion_connections").delete().eq("user_id", user.id);
      return json({ ok: true, connected: false });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function getUser(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const c = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await c.auth.getUser();
  return user;
}

async function statusFor(userId: string) {
  const { data } = await admin
    .from("notion_connections")
    .select("workspace_name, workspace_icon, database_id, database_url")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { connected: false };
  return {
    connected: true,
    workspace_name: data.workspace_name,
    workspace_icon: data.workspace_icon,
    database_id: data.database_id,
    database_url: data.database_url,
  };
}

async function handleStart(userId: string) {
  // A random state nonce ties Notion's redirect back to this user.
  const state = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await admin.from("notion_oauth_states").insert({ state, user_id: userId });

  const authorize = new URL("https://api.notion.com/v1/oauth/authorize");
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("owner", "user");
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("state", state);
  return json({ url: authorize.toString() });
}

async function handleCallback(url: URL) {
  const err = url.searchParams.get("error");
  if (err) return page(`Notion connection was cancelled (${escapeHtml(err)}).`, false);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return page("Missing code or state from Notion.", false);

  // Resolve + consume the state nonce (one-time).
  const { data: st } = await admin
    .from("notion_oauth_states").select("user_id").eq("state", state).maybeSingle();
  if (!st) return page("This connection link has expired. Please try connecting again.", false);
  await admin.from("notion_oauth_states").delete().eq("state", state);
  const userId = st.user_id as string;

  // Exchange the code for a workspace-scoped bot token.
  const basic = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const tokenResp = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  const tok = await tokenResp.json();
  if (!tokenResp.ok) return page(`Notion rejected the connection: ${escapeHtml(tok.error || tokenResp.status)}.`, false);

  const accessToken: string = tok.access_token;

  // Figure out the target database:
  //  - template flow: Notion returns duplicated_template_id (our template DB)
  //  - otherwise: create "Winday Meeting Notes" under the first granted page
  let databaseId: string | null = tok.duplicated_template_id ?? null;
  let databaseUrl: string | null = null;

  if (databaseId) {
    databaseUrl = await fetchDatabaseUrl(accessToken, databaseId);
  } else {
    const made = await createDatabase(accessToken);
    databaseId = made.id;
    databaseUrl = made.url;
  }

  await admin.from("notion_connections").upsert({
    user_id: userId,
    access_token: accessToken,
    bot_id: tok.bot_id ?? null,
    workspace_id: tok.workspace_id ?? null,
    workspace_name: tok.workspace_name ?? null,
    workspace_icon: tok.workspace_icon ?? null,
    database_id: databaseId,
    database_url: databaseUrl,
    updated_at: new Date().toISOString(),
  });

  return page(
    databaseId
      ? "✅ Notion connected. Your meeting notes will be saved automatically. You can close this tab."
      : "✅ Notion connected, but no database could be created — grant access to at least one page and reconnect.",
    true,
  );
}

// Create the "Winday Meeting Notes" database under the first page the token can
// see. Its only required column is the title; export-notion writes a title + body.
async function createDatabase(token: string): Promise<{ id: string | null; url: string | null }> {
  const searchResp = await notion(token, "POST", "/v1/search", {
    filter: { value: "page", property: "object" },
    page_size: 5,
  });
  const search = await searchResp.json();
  const parent = (search.results || []).find((r: any) => r.object === "page");
  if (!parent) return { id: null, url: null };

  const dbResp = await notion(token, "POST", "/v1/databases", {
    parent: { type: "page_id", page_id: parent.id },
    icon: { type: "emoji", emoji: "📝" },
    title: [{ type: "text", text: { content: "Winday Meeting Notes" } }],
    properties: {
      Name: { title: {} },
      Date: { date: {} },
      Company: { rich_text: {} },
    },
  });
  const db = await dbResp.json();
  if (!dbResp.ok) return { id: null, url: null };
  return { id: db.id, url: db.url ?? null };
}

async function fetchDatabaseUrl(token: string, databaseId: string): Promise<string | null> {
  try {
    const r = await notion(token, "GET", `/v1/databases/${databaseId}`);
    const d = await r.json();
    return d.url ?? null;
  } catch {
    return null;
  }
}

function notion(token: string, method: string, path: string, body?: unknown) {
  return fetch(`https://api.notion.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function page(message: string, ok: boolean) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Winday · Notion</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:#FAF9F5;color:#1F1E1D}
  .card{max-width:420px;padding:32px;text-align:center;border:1px solid #D6D3CB;border-radius:16px;background:#fff}
  .em{font-size:34px}
  p{font-size:15px;line-height:1.5;margin:14px 0 0}
  @media (prefers-color-scheme: dark){body{background:#1B1A18;color:#F2F1EC}.card{background:#232220;border-color:#3A3835}}
</style></head><body><div class="card"><div class="em">${ok ? "🎉" : "⚠️"}</div><p>${escapeHtml(message)}</p></div></body></html>`;
  return new Response(html, { status: 200, headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: unknown) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
