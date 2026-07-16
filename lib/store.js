// Thin wrapper over chrome.storage.local for the three pieces of state the
// extension persists: the Supabase auth session, the user's settings, and the
// local list of recorded meetings (a cache — the durable copy lives in Postgres,
// written by the Edge Functions). Shared by the background worker, the offscreen
// document, the popup and the options page.
import { CONFIG } from "../config.js";

const KEYS = {
  session: "wn_session",
  settings: "wn_settings",
  meetings: "wn_meetings",
  micGranted: "wn_mic_granted",
};

async function get(key) {
  const obj = await chrome.storage.local.get(key);
  return obj[key];
}
async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// --- Session -------------------------------------------------------------

export async function getSession() {
  return (await get(KEYS.session)) ?? null;
}
export async function setSession(session) {
  if (session) await set(KEYS.session, session);
  else await chrome.storage.local.remove(KEYS.session);
}

// --- Settings ------------------------------------------------------------

export const DEFAULT_SUMMARY_PROMPT =
  "You are an expert sales/meeting assistant for Winday CRM. Analyze the " +
  "following meeting transcript and produce structured notes. The speaker " +
  'labelled "You" is the app\'s user; "Participant 1/2/…" are the other ' +
  "attendees. Be concise and action-oriented. For next_steps, infer the owner " +
  "when possible (the user vs a participant) and assign a realistic priority. " +
  "Write in the same language as the transcript.";

export function defaultSettings() {
  return {
    notionDatabaseID: "",
    deepgramModel: CONFIG.deepgramModel,
    geminiModel: CONFIG.geminiModel,
    autoExportToNotion: true,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    summaryLength: "medium",
  };
}

export async function getSettings() {
  const saved = (await get(KEYS.settings)) ?? {};
  return { ...defaultSettings(), ...saved };
}
export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await set(KEYS.settings, next);
  return next;
}

// --- Meetings (local cache) ---------------------------------------------

export async function getMeetings() {
  return (await get(KEYS.meetings)) ?? [];
}
export async function saveMeetings(list) {
  await set(KEYS.meetings, list);
}
/** Insert or update a meeting by id, newest first, and persist. */
export async function upsertMeeting(meeting) {
  const list = await getMeetings();
  const idx = list.findIndex((m) => m.id === meeting.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...meeting };
  else list.unshift(meeting);
  await saveMeetings(list);
  return list;
}
export async function removeMeeting(id) {
  const list = (await getMeetings()).filter((m) => m.id !== id);
  await saveMeetings(list);
  return list;
}

// --- Microphone permission flag -----------------------------------------

export async function getMicGranted() {
  return (await get(KEYS.micGranted)) === true;
}
export async function setMicGranted(v) {
  await set(KEYS.micGranted, v === true);
}
