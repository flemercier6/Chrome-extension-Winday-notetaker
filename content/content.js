// Content script for meet.google.com. Detects a live call and shows a small
// floating pill (in a shadow root, isolated from Meet's CSS) that mirrors the
// recorder state: idle -> recording -> processing -> done/failed. Starting is
// delegated to the toolbar popup (which holds the user gesture + activeTab
// needed to mint the tab's capture stream id); stop / retry / dismiss are
// handled here directly.

const ACCENT = "#0077FF";
let host, root, els;
let state = { phase: "idle" };
let inCall = false;
let tick = null;

// A Meet call URL carries a meeting code: meet.google.com/abc-defg-hij.
function detectInCall() {
  return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/.test(location.pathname);
}

function mount() {
  if (host) return;
  host = document.createElement("div");
  host.id = "winday-notetaker-root";
  host.style.cssText =
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;";
  root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
      .card {
        display: inline-flex; align-items: center; gap: 12px;
        background: #F9F8F7; border: 1px solid #E0E0E0; border-radius: 10px;
        padding: 8px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
        color: #111; font-size: 13px; white-space: nowrap;
      }
      .logo { width: 18px; height: 18px; flex: 0 0 auto; }
      .dot { width: 9px; height: 9px; border-radius: 50%; background: #E5484D; animation: pulse 1.2s ease-in-out infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
      .time { font-variant-numeric: tabular-nums; font-weight: 600; }
      .spinner { width: 13px; height: 13px; border: 2px solid #ccc; border-top-color: ${ACCENT}; border-radius: 50%; animation: spin .8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      button {
        border: 0; border-radius: 7px; padding: 6px 12px; font-size: 13px; font-weight: 500;
        cursor: pointer; color: #fff; background: ${ACCENT};
      }
      button.ghost { background: transparent; color: #666; padding: 6px 8px; }
      button.stop { background: #E5484D; }
      a { color: ${ACCENT}; text-decoration: none; font-weight: 600; }
      .muted { color: #888; }
      .hidden { display: none; }
    </style>
    <div class="card" part="card">
      <svg class="logo" viewBox="0 0 24 24" fill="${ACCENT}" aria-hidden="true">
        <rect x="3" y="9" width="2.5" height="6" rx="1.25"/>
        <rect x="7.5" y="6" width="2.5" height="12" rx="1.25"/>
        <rect x="12" y="3" width="2.5" height="18" rx="1.25"/>
        <rect x="16.5" y="7" width="2.5" height="10" rx="1.25"/>
        <rect x="21" y="10" width="2.5" height="4" rx="1.25"/>
      </svg>
      <span class="body"></span>
    </div>`;
  els = { card: root.querySelector(".card"), body: root.querySelector(".body") };
  document.documentElement.appendChild(host);
}

function unmount() {
  if (tick) { clearInterval(tick); tick = null; }
  if (host) { host.remove(); host = root = els = null; }
}

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function send(type, extra) {
  return chrome.runtime.sendMessage({ type, ...(extra || {}) }).catch(() => {});
}

function render() {
  if (!inCall) { unmount(); return; }
  mount();
  const b = els.body;
  b.innerHTML = "";
  if (tick) { clearInterval(tick); tick = null; }

  const phase = state.phase;
  if (phase === "recording") {
    const dot = document.createElement("span"); dot.className = "dot";
    const time = document.createElement("span"); time.className = "time";
    const started = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
    const update = () => (time.textContent = fmt((Date.now() - started) / 1000));
    update(); tick = setInterval(update, 1000);
    const stop = button("Stop", "stop", () => send("WN_STOP"));
    b.append(dot, time, stop);
  } else if (phase === "processing") {
    const sp = document.createElement("span"); sp.className = "spinner";
    const label = document.createElement("span");
    label.textContent = stageLabel(state.stage);
    b.append(sp, label);
  } else if (phase === "done") {
    const ok = document.createElement("span"); ok.textContent = "✅ Notes prêtes"; ok.style.fontWeight = "600";
    b.append(ok);
    if (state.notionURL) {
      const a = document.createElement("a"); a.href = state.notionURL; a.target = "_blank"; a.textContent = "Ouvrir dans Notion";
      b.append(a);
    }
    b.append(button("✕", "ghost", () => send("WN_DISMISS")));
  } else if (phase === "failed") {
    const warn = document.createElement("span"); warn.textContent = "⚠︎ Échec du traitement";
    b.append(warn);
    if (state.meetingId) b.append(button("Réessayer", "", () => send("WN_RETRY", { id: state.meetingId })));
    b.append(button("✕", "ghost", () => send("WN_DISMISS")));
  } else {
    // idle + in a call: offer to record — opens the side panel (pushes the
    // page, no overlay), where the record button lives.
    const label = document.createElement("span"); label.textContent = "Winday Notetaker";
    const rec = button("Enregistrer", "", async () => {
      const r = await send("WN_OPEN_SIDEPANEL");
      if (!r || r.ok === false) {
        label.textContent = "Cliquez sur l'icône Winday ↗";
        label.className = "muted";
      }
    });
    b.append(label, rec);
  }
}

function button(text, cls, onClick) {
  const el = document.createElement("button");
  el.textContent = text;
  if (cls) el.className = cls;
  el.addEventListener("click", onClick);
  return el;
}

function stageLabel(stage) {
  return (
    { uploading: "Préparation…", transcribing: "Transcription…", summarizing: "Résumé…", exporting: "Enregistrement des notes…" }[stage] ||
    "Traitement…"
  );
}

// --- Wiring --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "WN_STATE") { state = msg.state || { phase: "idle" }; render(); }
});

async function refreshState() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "WN_GET_STATE" });
    if (r?.state) state = r.state;
  } catch (_) {}
  render();
}

function poll() {
  const now = detectInCall();
  if (now !== inCall) { inCall = now; render(); }
}

setInterval(poll, 1500);
poll();
refreshState();
