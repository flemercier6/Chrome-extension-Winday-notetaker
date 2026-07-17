// extension-session — mints a NEW, independent auth session for the extension.
//
// The extension's web sign-in bridges the CRM tab's Supabase session across.
// But that session BELONGS to the CRM web app: supabase-js there keeps rotating
// its refresh token, so the extension's copy soon dies with "Invalid Refresh
// Token: Already Used" (and with several devices, faster). The fix: right after
// bridging, the extension calls this function with the bridged (still valid)
// token and receives a one-time magiclink token_hash for the SAME user; it
// verifies it against /auth/v1/verify and gets its own session — its own
// refresh-token family, independent per device, never raced by the CRM.
//
// Requires a valid user JWT (gateway verify_jwt=true). Only ever issues a
// session for the calling user's own email — no escalation possible.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user || !user.email) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: user.email,
    });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) return json({ error: String(error?.message || "Could not create a session link") }, 500);

    return json({ token_hash: tokenHash });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}
