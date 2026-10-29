// Runs before rendering under script-src 'self'; keep preference handling aligned with src/theme.ts.
(() => {
  let saved = "system";
  try {
    const value = window.localStorage.getItem("pi-web.theme.v1");
    if (value === "light" || value === "dark") saved = value;
  } catch { /* Storage denial falls back to the system theme. */ }
  const dark = saved === "dark" ||
    (saved === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
