// The panel UI. Hosted as an iframe the content script docks over the Meet
// page (also usable as a full-tab dashboard from the toolbar icon elsewhere).
// Responsibilities: sign-in, the record trigger, live recording and pipeline
// status, and the recordings list.
//
// Recording starts through the service worker's SILENT path (tabCapture in
// the offscreen document) whenever the call's tab carries the activeTab grant
// (icon click / context menu / ⌘⇧9). When Chromium refuses, the panel runs
// the fallback ITSELF: getDisplayMedia — the standard share dialog, which
// needs no grant and exists in every Chromium (Arc included). Since the panel
// iframe lives inside the Meet tab, `preferCurrentTab` offers that very tab
// in one click, and the shared recording engine (lib/capture.js) runs here.
import * as sb from "../lib/supabase.js";
import * as store from "../lib/store.js";
import { createRecorder, acquireMic, requestMicPermission } from "../lib/capture.js";

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
    // Also re-read micGranted: granting it from ANY surface (this panel,
    // another window, the options page) broadcasts WN_STATE, and every open
    // panel should drop its banner without needing its own round trip.
    Promise.all([store.getMeetings(), store.getMicGranted()]).then(([m, mic]) => {
      meetings = m;
      micGranted = mic;
      render();
    });
  }
  // Stop/cancel routed by the service worker when THIS panel hosts the
  // fallback recording.
  if (msg?.type === "WN_PANEL_STOP") panelRecorder?.stop(false);
  if (msg?.type === "WN_PANEL_CANCEL") panelRecorder?.stop(true);
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

let panelRecorder = null;
// Three hosting contexts: embedded iframe in the Meet tab (docked mode),
// the browser's native side panel (no tab, no parent), or a full-tab
// dashboard (has a tab).
const isEmbedded = window.parent !== window;
let isTabPage = false;
chrome.tabs.getCurrent().then((t) => { isTabPage = !!t && !isEmbedded; }).catch(() => {});

async function startRecording() {
  // 1) Silent path via the service worker (tabCapture -> offscreen).
  const r = await chrome.runtime
    .sendMessage({ type: "WN_RECORD_TAB" })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (r?.ok) return;
  if (!r?.needsPickerFallback) {
    return recorderHint(r?.error || "Impossible de capturer l'onglet du call.");
  }

  // 2) Fallback: capture HERE via the standard share dialog. Works embedded
  //    in the Meet tab (one-click, preferCurrentTab) and in the native side
  //    panel (generic picker). A full-tab dashboard has no call to point at.
  if (isTabPage) {
    return recorderHint("Ouvrez le panneau depuis l'onglet du call, puis relancez.");
  }
  recorderHint("Dans la fenêtre de partage : choisissez l'onglet du call et laissez « Partager l'audio » activé.", false);
  let tabStream;
  try {
    tabStream = await captureThisTab();
  } catch (e) {
    return recorderHint("Partage annulé (" + String(e?.message || e) + ") — relancez et cliquez « Partager ».");
  }
  if (tabStream.getAudioTracks().length === 0) {
    tabStream.getTracks().forEach((t) => t.stop());
    return recorderHint("Aucun audio partagé — relancez et laissez « Partager l'audio de l'onglet » activé.");
  }
  // Only the audio matters; drop the mandatory video track right away.
  tabStream.getVideoTracks().forEach((t) => t.stop());

  const micStream = await acquireMic();
  const meeting = {
    id: crypto.randomUUID(),
    title: r.title || `Meeting ${new Date().toLocaleString()}`,
    startedAt: new Date().toISOString(),
    calendar: null,
  };
  panelRecorder = createRecorder();
  try {
    await panelRecorder.start({
      tabStream,
      micStream,
      monitorTab: false, // getDisplayMedia keeps local playback — no re-routing
      meeting,
      session: await store.getSession(),
      settings: await store.getSettings(),
    });
  } catch (e) {
    panelRecorder.failNow(e);
    panelRecorder = null;
    return;
  }
  recorderHint("", false);
  await chrome.runtime
    .sendMessage({ type: "WN_PANEL_REC_STARTED", meeting: { id: meeting.id, title: meeting.title, startedAt: meeting.startedAt } })
    .catch(() => {});
  // If the user stops the share from the browser bar (or the source ends),
  // finish the meeting instead of recording silence.
  const audioTrack = tabStream.getAudioTracks()[0];
  audioTrack.addEventListener("ended", () => {
    if (panelRecorder?.isActive()) panelRecorder.stop(false);
  });
}

/** getDisplayMedia — scoped to this iframe's top-level tab (the Meet tab)
 *  when embedded; the generic tab picker from the native side panel. */
async function captureThisTab() {
  const base = { video: true, audio: true };
  const scoped = isEmbedded
    ? { ...base, preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "include" }
    : { ...base, systemAudio: "include" };
  try {
    return await navigator.mediaDevices.getDisplayMedia(scoped);
  } catch (e) {
    // Older builds reject unknown dictionary members with a TypeError: retry
    // with the plain form (generic picker; the user picks the call's tab).
    if (e && e.name === "TypeError") return navigator.mediaDevices.getDisplayMedia(base);
    throw e;
  }
}

function recorderHint(msg, isError = true) {
  const box = $("recorder");
  const hint = box.querySelector(".hint") || document.createElement("div");
  hint.className = "hint";
  hint.style.color = isError ? "#c0392b" : "";
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

/** Opens Settings as a plain tab instead of chrome.runtime.openOptionsPage() —
 *  that API can silently no-op on some Chromium forks (no error, no tab), which
 *  is exactly what left users unable to reach it at all. A direct tab open is a
 *  basic, universally-supported operation. Focuses an existing Options tab
 *  rather than piling up duplicates on repeated clicks. */
async function openSettings() {
  const url = chrome.runtime.getURL("options/options.html");
  try {
    const [existing] = await chrome.tabs.query({ url });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch (_) {
    /* fall through to a plain create */
  }
  chrome.tabs.create({ url }).catch(() => {});
}

// --- Events --------------------------------------------------------------

$("btn-signin").addEventListener("click", () => doSignIn("in"));
$("btn-signup").addEventListener("click", () => doSignIn("up"));
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doSignIn("in"); });
$("btn-signout").addEventListener("click", async () => { sb.signOut(); await store.setSession(null); session = null; render(); });
$("btn-settings").addEventListener("click", openSettings);

// Grant the mic permission INLINE — no navigation to a separate settings page.
// That page-hop (via chrome.runtime.openOptionsPage()) is what left users
// stuck: on some Chromium forks it silently no-ops, so "l'activer" looked
// like it did nothing. getUserMedia's own browser prompt appears right here.
$("mic-link").addEventListener("click", async (e) => {
  e.preventDefault();
  $("mic-banner-error").classList.add("hidden");
  try {
    await requestMicPermission();
    micGranted = true;
    render();
  } catch (err) {
    $("mic-banner-error").textContent =
      "Micro refusé (" + (err?.message || err) + "). Vérifiez l'icône du microphone/cadenas " +
      "dans la barre d'adresse, ou l'autorisation Microphone de ce site dans les réglages du navigateur.";
    $("mic-banner-error").classList.remove("hidden");
  }
});

// ✕ — embedded iframe: ask the host page (via the service worker) to hide it;
// native side panel or dashboard tab: window.close() does the right thing.
$("btn-close").classList.remove("hidden");
$("btn-close").addEventListener("click", () => {
  if (isEmbedded) chrome.runtime.sendMessage({ type: "WN_CLOSE_PANEL" }).catch(() => {});
  else window.close();
});

refresh();
