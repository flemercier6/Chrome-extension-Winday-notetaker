// The panel UI. Two hosting modes, same file:
//   1. Docked in the Meet page — the content script embeds this page as an
//      iframe fixed to the right edge and pushes the page content aside with a
//      margin (works in Arc, which doesn't render Chrome's native side panel).
//   2. Full-tab dashboard — opened by the toolbar icon on non-Meet tabs.
// Responsibilities: sign-in, the record trigger (start is delegated to the
// service worker, which mints the tab-capture stream id), live recording and
// pipeline status, and the recordings list.
import * as sb from "../lib/supabase.js";
import * as store from "../lib/store.js";

const $ = (id) => document.getElementById(id);
let state = { phase: "idle" };
let meetings = [];
let session = null;
let micGranted = false;
let timer = null;

// --- Boot ----------------------------------------------------------------

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "WN_GET_STATE" }).catch(() => null);
  if (r) {
    state = r.state || { phase: "idle" };
    meetings = r.meetings || [];
    session = r.session || null;
    micGranted = r.micGranted || false;
  } else {
    session = await store.getSession();
    meetings = await store.getMeetings();
  }
  render();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "WN_STATE") {
    state = msg.state || { phase: "idle" };
    store.getMeetings().then((m) => { meetings = m; render(); });
  }
});

// --- Render --------------------------------------------------------------

function render() {
  if (timer) { clearInterval(timer); timer = null; }
  const signedIn = !!session;
  $("signin").classList.toggle("hidden", signedIn);
  $("main").classList.toggle("hidden", !signedIn);
  if (!signedIn) return;

  $("user-email").textContent = session.email || "";
  $("mic-banner").classList.toggle("hidden", micGranted);
  renderRecorder();
  renderList();
}

function renderRecorder() {
  const box = $("recorder");
  box.innerHTML = "";
  const phase = state.phase;

  if (phase === "recording") {
    const status = div("status");
    status.append(span("dot"), timeEl());
    const stop = btn("Arrêter et enregistrer", "stop", () => chrome.runtime.sendMessage({ type: "WN_STOP" }));
    const cancel = btn("Annuler (ne pas garder)", "ghost", () => chrome.runtime.sendMessage({ type: "WN_CANCEL" }));
    box.append(status, stop, cancel);
  } else if (phase === "processing") {
    const status = div("status");
    status.append(span("spinner"), text(stageLabel(state.stage)));
    box.append(status);
  } else if (phase === "done") {
    const status = div("status");
    status.append(text("✅ Notes prêtes"));
    box.append(status);
    if (state.notionURL) box.append(linkBtn("Ouvrir dans Notion", state.notionURL));
    box.append(btn("OK", "ghost", () => chrome.runtime.sendMessage({ type: "WN_DISMISS" })));
  } else if (phase === "failed") {
    const status = div("status");
    status.append(text("⚠︎ " + (state.error || "Échec du traitement")));
    box.append(status);
    if (state.meetingId) box.append(btn("Réessayer", "record", () => chrome.runtime.sendMessage({ type: "WN_RETRY", id: state.meetingId })));
    box.append(btn("Ignorer", "ghost", () => chrome.runtime.sendMessage({ type: "WN_DISMISS" })));
  } else {
    const rec = btn("● Enregistrer cet appel", "record", startRecording);
    box.append(rec);
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Ouvrez l'onglet de votre Google Meet, puis lancez l'enregistrement.";
    box.append(hint);
  }
}

function renderList() {
  const list = $("list");
  list.innerHTML = "";
  const items = meetings.filter((m) => m.status !== "recording");
  if (items.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Aucun enregistrement pour le moment.";
    list.append(e);
    return;
  }
  for (const m of items) list.append(itemRow(m));
}

function itemRow(m) {
  const row = div("item");
  const main = document.createElement("div");
  main.style.flex = "1";
  main.style.overflow = "hidden";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = m.title || "Sans titre";
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = subtitle(m);
  main.append(title, sub);

  const tag = document.createElement("span");
  const t = statusTag(m.status);
  tag.className = "tag " + t.cls;
  tag.textContent = t.label;

  const actions = div("item-actions");
  const busy = ["transcribing", "summarizing", "exporting"].includes(m.status);
  if (!busy) {
    if (m.status === "recorded" || m.status === "failed")
      actions.append(iconBtn("↻", "Transcrire & résumer", () => chrome.runtime.sendMessage({ type: "WN_RETRY", id: m.id })));
    if (m.status === "ready" && !m.notionPageURL)
      actions.append(iconBtn("➤", "Envoyer vers Notion", () => chrome.runtime.sendMessage({ type: "WN_EXPORT", id: m.id })));
    if (m.notionPageURL) actions.append(iconLink("⧉", "Ouvrir dans Notion", m.notionPageURL));
    actions.append(iconLink("◫", "Ouvrir dans le CRM", crmURL(m)));
    const del = iconBtn("🗑", "Supprimer", () => chrome.runtime.sendMessage({ type: "WN_DISCARD", id: m.id }));
    del.classList.add("del");
    actions.append(del);
  }
  row.append(main, tag, actions);
  return row;
}

// --- Actions -------------------------------------------------------------

/** The tab to record: when the panel is embedded in the Meet page, that page's
 *  own tab; when open as a full-tab dashboard, the window's active tab. */
async function targetTab() {
  const cur = await chrome.tabs.getCurrent().catch(() => null);
  if (cur && /^https:\/\/meet\.google\.com\//.test(cur.url || "")) return cur;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active || null;
}

async function startRecording() {
  const tab = await targetTab();
  if (!tab || !/^https?:/.test(tab.url || "")) {
    return recorderHint("Ouvrez l'onglet de votre réunion (Google Meet), puis réessayez.");
  }
  // The stream id is minted by the service worker — what authorizes it is the
  // activeTab grant on the call's tab (icon click / context menu / shortcut).
  const r = await chrome.runtime
    .sendMessage({ type: "WN_RECORD_TAB", tabId: tab.id, title: deriveTitle(tab) })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (!r || r.ok === false) {
    recorderHint(
      "Impossible de capturer (" + (r?.error || "erreur inconnue") + "). " +
      "Faites un clic droit sur la page du call → « Winday Notetaker — Enregistrer ce call », " +
      "ou cliquez une fois sur l'icône de l'extension, puis réessayez.",
    );
  }
}

function recorderHint(msg) {
  const box = $("recorder");
  const hint = box.querySelector(".hint") || document.createElement("div");
  hint.className = "hint";
  hint.style.color = "#c0392b";
  hint.textContent = msg;
  if (!hint.parentNode) box.append(hint);
}

async function doSignIn(kind) {
  const email = $("email").value.trim();
  const password = $("password").value;
  const err = $("auth-error");
  err.classList.add("hidden");
  if (!email || !password) return;
  $("btn-signin").disabled = $("btn-signup").disabled = true;
  try {
    session = kind === "up" ? await sb.signUp(email, password) : await sb.signIn(email, password);
    await store.setSession(session); // the REST client keeps it in memory only; persist it here
    await refresh();
  } catch (e) {
    err.textContent = e?.message || String(e);
    err.classList.remove("hidden");
  } finally {
    $("btn-signin").disabled = $("btn-signup").disabled = false;
  }
}

// --- Helpers -------------------------------------------------------------

function deriveTitle(tab) {
  let t = (tab.title || "").replace(/\s*[-–]\s*Google Meet\s*$/i, "").replace(/^Meet\s*[-–]\s*/i, "").trim();
  if (!t || /^meet\.google\.com/i.test(t)) t = `Meeting ${new Date().toLocaleString()}`;
  return t;
}
function subtitle(m) {
  const parts = [];
  if (m.calendar?.companyName) parts.push(m.calendar.companyName);
  if (m.startedAt) parts.push(new Date(m.startedAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  if (m.endedAt && m.startedAt) {
    const min = Math.round((new Date(m.endedAt) - new Date(m.startedAt)) / 60000);
    if (min > 0) parts.push(`${min} min`);
  }
  return parts.join("  ·  ");
}
function statusTag(status) {
  switch (status) {
    case "exported": return { cls: "exported", label: "Dans Notion" };
    case "ready": return { cls: "ready", label: "Résumé" };
    case "failed": return { cls: "failed", label: "Échec" };
    case "transcribing": case "summarizing": case "exporting": return { cls: "busy", label: "Traitement…" };
    default: return { cls: "recorded", label: "Non traité" };
  }
}
function stageLabel(stage) {
  return { uploading: "Préparation…", transcribing: "Transcription…", summarizing: "Résumé…", exporting: "Enregistrement des notes…" }[stage] || "Traitement…";
}
function crmURL(m) {
  return `https://crm.winday.app/meetings?m=${(m.id || "").toLowerCase()}`;
}
function timeEl() {
  const el = span("time");
  const started = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
  const upd = () => (el.textContent = fmt((Date.now() - started) / 1000));
  upd();
  timer = setInterval(upd, 1000);
  return el;
}
function fmt(sec) { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function div(cls) { const d = document.createElement("div"); d.className = cls; return d; }
function span(cls) { const s = document.createElement("span"); s.className = cls; return s; }
function text(t) { const s = document.createElement("span"); s.textContent = t; return s; }
function btn(label, cls, onClick) { const b = document.createElement("button"); b.textContent = label; b.className = cls; b.addEventListener("click", onClick); return b; }
function iconBtn(label, title, onClick) { const b = document.createElement("button"); b.textContent = label; b.title = title; b.addEventListener("click", onClick); return b; }
function iconLink(label, title, url) { const a = document.createElement("button"); a.textContent = label; a.title = title; a.addEventListener("click", () => chrome.tabs.create({ url })); return a; }
function linkBtn(label, url) { return btn(label, "record", () => chrome.tabs.create({ url })); }

// --- Events --------------------------------------------------------------

$("btn-signin").addEventListener("click", () => doSignIn("in"));
$("btn-signup").addEventListener("click", () => doSignIn("up"));
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doSignIn("in"); });
$("btn-signout").addEventListener("click", async () => { sb.signOut(); await store.setSession(null); session = null; render(); });
$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("mic-link").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

// Embedded in the Meet page (iframe): show ✕, which asks the host page —
// via the service worker — to undock the panel.
if (window.parent !== window) {
  $("btn-close").classList.remove("hidden");
  $("btn-close").addEventListener("click", () => chrome.runtime.sendMessage({ type: "WN_CLOSE_PANEL" }).catch(() => {}));
}

refresh();
