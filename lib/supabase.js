// Thin Supabase REST client for the extension: email+password auth, Storage
// upload, PostgREST inserts and Edge Function invocation. Mirrors the macOS
// app's SupabaseClient. No third-party secrets ever pass through here — the
// Edge Functions hold Deepgram/Gemini/Notion keys server-side.
//
// Works from any extension context that can `import` (background worker,
// offscreen document, popup, options). host_permissions on the Supabase origin
// let these cross-origin fetches through without CORS friction.
import { CONFIG } from "../config.js";
import { getSession, setSession } from "./store.js";

const BASE = CONFIG.supabaseURL.replace(/\/+$/, "");
const ANON = CONFIG.supabaseAnonKey;

export class HttpError extends Error {
  constructor(status, body) {
    super(`Request failed (HTTP ${status}): ${body}`);
    this.status = status;
    this.body = body;
  }
}

function endpoint(path) {
  return BASE + path;
}

async function check(resp) {
  if (resp.ok) return resp;
  const text = await resp.text();
  let message = text;
  try {
    const obj = JSON.parse(text);
    message = obj.error || obj.msg || obj.message || text;
  } catch (_) {
    /* keep raw text */
  }
  throw new HttpError(resp.status, message);
}

// --- Auth ----------------------------------------------------------------

function sessionFromToken(token) {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    userId: token.user?.id,
    email: token.user?.email ?? null,
  };
}

export async function signIn(email, password) {
  const resp = await fetch(endpoint("/auth/v1/token?grant_type=password"), {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  await check(resp);
  const token = await resp.json();
  if (!token.access_token) throw new HttpError(200, "Sign-in failed — check your email and password.");
  const session = sessionFromToken(token);
  await setSession(session);
  return session;
}

export async function signUp(email, password) {
  const resp = await fetch(endpoint("/auth/v1/signup"), {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  await check(resp);
  const token = await resp.json();
  if (!token.access_token) {
    throw new HttpError(
      200,
      "Account created, but email confirmation is on. Confirm via the email, then sign in.",
    );
  }
  const session = sessionFromToken(token);
  await setSession(session);
  return session;
}

export async function signOut() {
  await setSession(null);
}

/** Returns a valid access token, refreshing if it is within 60s of expiry. */
async function accessToken() {
  let session = await getSession();
  if (!session) throw new HttpError(401, "You need to sign in first.");
  if (session.expiresAt - Date.now() > 60_000) return session.accessToken;

  const resp = await fetch(endpoint("/auth/v1/token?grant_type=refresh_token"), {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  await check(resp);
  const token = await resp.json();
  session = sessionFromToken(token);
  await setSession(session);
  return session.accessToken;
}

export async function currentUserId() {
  const s = await getSession();
  return s?.userId ?? null;
}

// --- Storage -------------------------------------------------------------

/** Uploads a Blob to the private `recordings` bucket at `path`. */
export async function uploadRecording(blob, path, contentType = "application/octet-stream") {
  const token = await accessToken();
  const resp = await fetch(endpoint(`/storage/v1/object/recordings/${path}`), {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: blob,
  });
  await check(resp);
}

// --- PostgREST -----------------------------------------------------------

async function postREST(path, body, prefer) {
  const token = await accessToken();
  const resp = await fetch(endpoint(path), {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  await check(resp);
}

/** Inserts a meeting row (idempotent: an existing id is left untouched). */
export async function insertMeeting(payload) {
  await postREST("/rest/v1/meetings?on_conflict=id", payload, "resolution=ignore-duplicates,return=minimal");
}

/** Links a meeting to CRM contacts (idempotent). */
export async function linkMeetingContacts(meetingID, contactIDs, userId) {
  if (!contactIDs || contactIDs.length === 0) return;
  const rows = contactIDs.map((cid) => ({ meeting_id: meetingID, contact_id: cid, user_id: userId }));
  await postREST(
    "/rest/v1/meeting_contacts?on_conflict=meeting_id,contact_id",
    rows,
    "resolution=ignore-duplicates,return=minimal",
  );
}

// --- Edge Functions ------------------------------------------------------

export async function invokeRaw(name, body) {
  const token = await accessToken();
  const resp = await fetch(endpoint(`/functions/v1/${name}`), {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await check(resp);
  return resp.json();
}

/** Fetches the signed-in user's imminent calendar calls (best-effort). */
export async function fetchUpcomingMeetings(withinMinutes = 15) {
  return invokeRaw("upcoming-meetings", { within_minutes: withinMinutes });
}
