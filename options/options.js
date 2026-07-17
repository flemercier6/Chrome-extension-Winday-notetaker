import * as store from "../lib/store.js";
import * as sb from "../lib/supabase.js";
import { requestMicPermission } from "../lib/capture.js";
import { applyTheme } from "../lib/theme.js";
import { icon } from "../lib/icons.js";

const $ = (id) => document.getElementById(id);
const fields = ["theme", "transcriptionLanguage", "panelMode", "notionDatabaseID", "autoExportToNotion", "summaryPrompt", "summaryLength", "deepgramModel", "geminiModel"];

async function load() {
  const s = await store.getSettings();
  applyTheme(s.theme);
  $("theme").value = s.theme;
  $("transcriptionLanguage").value = s.transcriptionLanguage || "multi";
  $("panelMode").value = s.panelMode === "docked" ? "docked" : "native";
  $("notionDatabaseID").value = s.notionDatabaseID;
  $("autoExportToNotion").checked = s.autoExportToNotion;
  $("summaryPrompt").value = s.summaryPrompt;
  $("summaryLength").value = s.summaryLength;
  $("deepgramModel").value = s.deepgramModel;
  $("geminiModel").value = s.geminiModel;
  updateMicStatus(await store.getMicGranted());

  // Notion connection needs the signed-in user's session.
  const session = await store.getSession();
  if (session) sb.useSession(session, (ns) => store.setSession(ns).catch(() => {}), () => store.getSession());
  refreshNotion(session);
}

// --- Notion connection ---------------------------------------------------

// When the Winday session is missing or DEAD (revoked refresh token), the
// Connect button becomes a "Sign in to Winday" button instead of erroring.
let needsSignin = false;

function renderNotion(status) {
  const dot = $("notion-dot");
  const text = $("notion-status-text");
  const connectBtn = $("btn-notion-connect");
  const disconnectBtn = $("btn-notion-disconnect");
  const dbLink = $("notion-db-link");

  const connected = !!(status && status.connected);
  dot.classList.toggle("on", connected);
  if (connected) {
    needsSignin = false;
    const ws = status.workspace_name ? ` · ${status.workspace_name}` : "";
    text.textContent = `Connected${ws}`;
    connectBtn.textContent = "Reconnect";
    disconnectBtn.hidden = false;
    if (status.database_url) { dbLink.href = status.database_url; dbLink.hidden = false; }
    else dbLink.hidden = true;
  } else {
    text.textContent = needsSignin
      ? "Your Winday session has expired — sign in again to continue."
      : (status && status.error ? "Sign in to Winday to connect Notion" : "Not connected");
    connectBtn.textContent = needsSignin ? "Sign in to Winday" : "Connect Notion";
    disconnectBtn.hidden = true;
    dbLink.hidden = true;
  }
  // Cache for the recorder's auto-export gate (server stays source of truth).
  store.setSettings({ notionConnected: connected }).catch(() => {});
}

async function refreshNotion(session) {
  if (!session) { needsSignin = true; renderNotion({ connected: false }); return null; }
  try {
    const status = await sb.notionStatus();
    renderNotion(status);
    return status;
  } catch (e) {
    if (sb.isSessionDead(e)) needsSignin = true;
    renderNotion({ connected: false, error: sb.isSessionDead(e) ? undefined : String(e) });
    return null;
  }
}

let pollTimer = null;
async function connectNotion() {
  const btn = $("btn-notion-connect");
  const session = await store.getSession();
  if (needsSignin || !session) {
    // The button reads "Sign in to Winday": run the web sign-in right here —
    // the service worker opens the CRM tab, bridges + exchanges the session,
    // and our storage listener below picks it up automatically.
    $("notion-status-text").textContent = "Opening Winday sign-in…";
    chrome.runtime.sendMessage({ type: "WN_SIGN_IN_WEB" }).catch(() => {});
    return;
  }
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Opening Notion…";
  try {
    const { url } = await sb.notionStart();
    const authTab = await chrome.tabs.create({ url, active: true });
    $("notion-status-text").textContent = "Waiting for Notion authorization…";
    // Poll until the callback stores the connection (or the user gives up).
    clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(async () => {
      tries++;
      const status = await refreshNotion(session).catch(() => null);
      if ((status && status.connected) || tries > 40) {
        clearInterval(pollTimer);
        btn.disabled = false;
        if (status && status.connected) {
          // Tidy up: close the Notion tab (now on our confirmation page) and
          // bring Settings back to the front, showing "Connected".
          if (authTab && authTab.id != null) chrome.tabs.remove(authTab.id).catch(() => {});
          chrome.tabs.getCurrent().then((me) => {
            if (me && me.id != null) chrome.tabs.update(me.id, { active: true }).catch(() => {});
          }).catch(() => {});
        }
      }
    }, 2500);
  } catch (e) {
    btn.textContent = prev;
    btn.disabled = false;
    if (sb.isSessionDead(e)) { needsSignin = true; renderNotion({ connected: false }); return; }
    $("notion-status-text").textContent = "Couldn't start Notion connection: " + (e?.message || e);
  }
}

async function disconnectNotion() {
  clearInterval(pollTimer);
  try { await sb.notionDisconnect(); } catch (_) {}
  renderNotion({ connected: false });
}

async function save() {
  const patch = {
    theme: $("theme").value,
    transcriptionLanguage: $("transcriptionLanguage").value,
    panelMode: $("panelMode").value === "docked" ? "docked" : "native",
    notionDatabaseID: $("notionDatabaseID").value.trim(),
    autoExportToNotion: $("autoExportToNotion").checked,
    summaryPrompt: $("summaryPrompt").value,
    summaryLength: $("summaryLength").value,
    deepgramModel: $("deepgramModel").value.trim() || "nova-3",
    geminiModel: $("geminiModel").value.trim() || "gemini-2.5-flash",
  };
  applyTheme(patch.theme); // reflect the choice on this page immediately
  await store.setSettings(patch);
  chrome.runtime.sendMessage({ type: "WN_SETTINGS_CHANGED" }).catch(() => {});
  flashSaved();
}

let savedTimer = null;
function flashSaved() {
  const el = $("saved");
  el.replaceChildren(icon("check", 14), document.createTextNode(" Saved"));
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (el.textContent = "Settings are saved automatically."), 1200);
}

function updateMicStatus(granted) {
  const el = $("mic-status");
  if (granted) el.replaceChildren(icon("check", 14), document.createTextNode(" Microphone allowed"));
  else el.textContent = "Not allowed";
  $("btn-mic").disabled = granted;
}

async function requestMic() {
  try {
    await requestMicPermission(); // reports WN_MIC_GRANTED -> background persists + broadcasts
    updateMicStatus(true);
  } catch (e) {
    $("mic-status").textContent = "Denied: " + (e?.message || e);
  }
}

// Wire up
for (const id of fields) {
  const el = $(id);
  const evt = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
  el.addEventListener(evt, save);
}
$("btn-reset-prompt").addEventListener("click", async () => {
  $("summaryPrompt").value = store.DEFAULT_SUMMARY_PROMPT;
  await save();
});
$("btn-mic").addEventListener("click", requestMic);
$("btn-notion-connect").addEventListener("click", connectNotion);
$("btn-notion-disconnect").addEventListener("click", disconnectNotion);

// Re-check the connection when returning to this tab (e.g. after authorizing).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) store.getSession().then(refreshNotion);
});

// React to the session changing while this page is open: a fresh sign-in
// re-enables Connect Notion right away; a sign-out flips to the prompt.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.wn_session) return;
  const s = changes.wn_session.newValue || null;
  needsSignin = !s;
  if (s) sb.useSession(s, (ns) => store.setSession(ns).catch(() => {}), () => store.getSession());
  refreshNotion(s);
});

load();
