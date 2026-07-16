// Content script for meet.google.com. Two jobs:
//
// 1. The floating pill (top center, shadow DOM): shows the recorder state —
//    idle -> recording (timer + stop) -> processing -> done/failed.
// 2. The DOCKED PANEL: the panel UI (sidepanel/sidepanel.html) embedded as an
//    iframe fixed to the right edge, over the page. The ✕ HIDES the iframe
//    instead of destroying it: a fallback (getDisplayMedia) recording runs
//    INSIDE that iframe, and must survive the panel being dismissed.
//
// Wrapped in a guard so the background can re-inject it (chrome.scripting)
// into tabs whose copy went stale without redeclaring top-level bindings.
(() => {
  if (window.__windayNotetaker) {
    return;
  }
  const api = {};
  window.__windayNotetaker = api;

  // Winday Data design-system palettes. The pill + docked panel live inside the
  // Meet page, so they can't use the extension's theme.css — we resolve the
  // user's Theme choice here and paint from these role-based tokens. Brand blue
  // is reserved for the mark, links and active states; primary is inverse.
  const PALETTES = {
    light: {
      cardBg: "#FAF9F5", cardBorder: "#D6D3CB", text: "#1F1E1D",
      secondary: "#6E6D66", muted: "#9B9A93", accent: "#3670B2", link: "#2E5F9C",
      danger: "#B4553F", inset: "#E8E6E0", btnBg: "#1F1E1D", btnText: "#FAF9F5",
      onDanger: "#FAF9F5", panelBg: "#FAF9F5", panelBorder: "#D6D3CB", shadow: "rgba(31,30,29,.14)",
    },
    dark: {
      cardBg: "#232220", cardBorder: "#3A3835", text: "#F2F1EC",
      secondary: "#B4B2AA", muted: "#86847C", accent: "#5B9BD8", link: "#82B3E8",
      danger: "#D98466", inset: "#333029", btnBg: "#F2F1EC", btnText: "#1F1E1D",
      onDanger: "#1B1A18", panelBg: "#1B1A18", panelBorder: "#3A3835", shadow: "rgba(0,0,0,.45)",
    },
  };
  let P = PALETTES.light; // active palette; set for real by initTheme() below
  const PANEL_WIDTH = 380;

  let host, root, els; // pill
  let panelHost = null; // docked panel (kept alive once created)
  let state = { phase: "idle" };
  let inCall = false;
  let tick = null;

  // --- Docked panel -------------------------------------------------------

  function openPanel() {
    if (panelHost) {
      panelHost.style.display = "block";
      return;
    }
    panelHost = document.createElement("winday-panel");
    panelHost.style.cssText = [
      "position:fixed",
      "top:0",
      "right:0",
      "bottom:0",
      `width:${PANEL_WIDTH}px`,
      "max-width:85vw",
      "z-index:2147483646",
      `background:${P.panelBg}`,
      `border-left:1px solid ${P.panelBorder}`,
      "box-shadow:-10px 0 30px rgba(0,0,0,.10)",
      "display:block",
    ].join(";");
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("sidepanel/sidepanel.html");
    // Let the embedded extension page use the mic and the share dialog for
    // the fallback capture path.
    frame.allow = "microphone; display-capture; autoplay";
    frame.style.cssText = "width:100%;height:100%;border:0;display:block;background:transparent;";
    panelHost.appendChild(frame);
    document.documentElement.appendChild(panelHost);
  }

  function hidePanel() {
    if (panelHost) panelHost.style.display = "none";
  }

  api.open = openPanel;
  api.close = hidePanel;

  // --- Pill ---------------------------------------------------------------

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
          background: ${P.cardBg}; border: 1px solid ${P.cardBorder}; border-radius: 12px;
          padding: 8px 12px; box-shadow: 0 6px 24px ${P.shadow};
          color: ${P.text}; font-size: 14px; white-space: nowrap;
        }
        .logo { width: 18px; height: 18px; flex: 0 0 auto; }
        .dot { width: 9px; height: 9px; border-radius: 999px; background: ${P.danger}; animation: pulse 1.2s ease-in-out infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        .time { font-variant-numeric: tabular-nums; font-weight: 500; }
        .spinner { width: 13px; height: 13px; border: 2px solid ${P.inset}; border-top-color: ${P.accent}; border-radius: 999px; animation: spin .8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        button {
          border: 0; border-radius: 6px; padding: 6px 12px; font-size: 13px; font-weight: 500;
          cursor: pointer; color: ${P.btnText}; background: ${P.btnBg};
        }
        button.ghost { background: transparent; color: ${P.secondary}; padding: 6px 8px; }
        button.stop { background: ${P.danger}; color: ${P.onDanger}; }
        a { color: ${P.link}; text-decoration: none; font-weight: 500; }
        .muted { color: ${P.muted}; }
      </style>
      <div class="card" part="card">
        <svg class="logo" viewBox="0 0 24 24" fill="${P.accent}" aria-hidden="true">
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
    // The pill is a lightweight prompt only: it shows when a call is imminent
    // (from the calendar) or you're on a call but not yet recording, and gets
    // out of the way once recording starts — the side panel owns the in-call UI.
    const phase = state.phase || "idle";
    const imm = state.imminentCall || null;
    if (phase !== "idle" || (!inCall && !imm)) { unmount(); return; }
    mount();
    const b = els.body;
    b.innerHTML = "";
    if (tick) { clearInterval(tick); tick = null; }

    if (inCall) {
      // On the call, not yet recording → start it (silent if the tab already
      // carries the activeTab grant) and reveal the panel.
      const label = document.createElement("span");
      label.textContent = imm && imm.title ? imm.title : "Winday Meet";
      const rec = button("● Record", "rec", async () => {
        const r = await send("WN_RECORD_TAB");
        const p = await send("WN_OPEN_PANEL");
        if (!p || p.mode === "docked" || p.ok === false || (r && !r.ok)) openPanel();
      });
      b.append(label, rec);
    } else if (imm) {
      // A scheduled call is imminent but we're not in it yet → jump to it.
      const label = document.createElement("span");
      label.textContent = `${imm.title || "Your meeting"} · starting now`;
      const join = button("Join", "rec", () => {
        if (imm.meet_url) location.href = imm.meet_url;
        else openPanel();
      });
      b.append(label, join);
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
      { uploading: "Preparing…", transcribing: "Transcribing…", summarizing: "Summarizing…", exporting: "Saving notes…" }[stage] ||
      "Processing…"
    );
  }

  // --- Wiring --------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "WN_STATE") {
      state = msg.state || { phase: "idle" };
      render();
    }
    if (msg?.type === "WN_TOGGLE_PANEL") {
      if (msg.ensure === "open") openPanel();
      else if (msg.ensure === "close") hidePanel();
      else if (panelHost && panelHost.style.display !== "none") hidePanel();
      else openPanel();
    }
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

  // --- Theme --------------------------------------------------------------
  // Mirror the extension's Theme setting for the pill + docked panel. "system"
  // follows the OS live; the choice is read from storage and watched for edits.
  const themeMQ = window.matchMedia("(prefers-color-scheme: dark)");
  let themeMode = "system";
  function resolveTheme() {
    if (themeMode === "light" || themeMode === "dark") return themeMode;
    return themeMQ.matches ? "dark" : "light";
  }
  function repaintTheme() {
    const next = PALETTES[resolveTheme()];
    if (next === P) return;
    P = next;
    if (panelHost) {
      panelHost.style.background = P.panelBg;
      panelHost.style.borderLeft = `1px solid ${P.panelBorder}`;
    }
    if (host) { unmount(); render(); } // rebuild the pill with the new palette
  }
  P = PALETTES[resolveTheme()]; // synchronous best guess before the first paint
  themeMQ.addEventListener("change", repaintTheme);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.wn_settings) {
      themeMode = changes.wn_settings.newValue?.theme || "system";
      repaintTheme();
    }
  });
  chrome.storage.local
    .get("wn_settings")
    .then(({ wn_settings }) => { themeMode = wn_settings?.theme || "system"; repaintTheme(); })
    .catch(() => {});

  setInterval(poll, 1500);
  poll();
  refreshState();
})();
