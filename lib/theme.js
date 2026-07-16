// Applies the user's Theme choice to the current document by writing data-theme
// on <html>. "light" / "dark" force the theme; "system" (the default) removes
// the override so theme.css follows the OS live via its prefers-color-scheme
// rule — no matchMedia listener needed. Safe to call repeatedly.
export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
  else root.removeAttribute("data-theme"); // "system"
}
