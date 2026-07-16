// Auth bridge, injected on the Winday CRM web app (crm.winday.app). The CRM
// runs on the SAME Supabase project as the extension, so a session obtained
// there is valid for the extension's own Supabase calls. supabase-js stores the
// session in the page's localStorage under `sb-<project-ref>-auth-token`;
// content scripts share the page's localStorage, so we read it and forward it
// to the service worker. No changes to the web app are needed.
//
// Flow: the panel's "Sign in with Winday" button opens the CRM in a popup
// window; this script grabs the session (immediately if the user is already
// logged in, otherwise once they finish logging in) and hands it back. The
// extension then keeps the session alive on its own via the refresh token.
(() => {
  const PROJECT_REF = "gagfovgnuttmngnhqzwd"; // must match config.js's Supabase project
  const KEY = `sb-${PROJECT_REF}-auth-token`;
  let done = false;

  function readSession() {
    let raw;
    try {
      raw = localStorage.getItem(KEY);
    } catch (_) {
      return null; // storage access denied
    }
    if (!raw) return null;
    let v;
    try {
      v = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    // supabase-js v2 stores the session object directly; some versions wrap it.
    const s = v && v.access_token ? v : (v && (v.currentSession || v.session)) || null;
    if (s && s.access_token && s.refresh_token) return s;
    return null;
  }

  function forward(s) {
    const session = {
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
      expiresAt: s.expires_at ? s.expires_at * 1000 : Date.now() + (s.expires_in || 3600) * 1000,
      userId: s.user && s.user.id,
      email: (s.user && s.user.email) || null,
    };
    try {
      chrome.runtime.sendMessage({ type: "WN_WEB_SESSION", session }, () => void chrome.runtime.lastError);
    } catch (_) {
      /* extension context gone */
    }
  }

  function tick() {
    if (done) return;
    const s = readSession();
    if (s) {
      done = true;
      forward(s);
    }
  }

  // Grab it now (already logged in) and keep watching for a few minutes in case
  // the user still has to log in. localStorage's `storage` event doesn't fire in
  // the same document, so we poll.
  tick();
  const iv = setInterval(() => {
    if (done) {
      clearInterval(iv);
      return;
    }
    tick();
  }, 800);
  setTimeout(() => clearInterval(iv), 5 * 60 * 1000);
})();
