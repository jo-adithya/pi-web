import { createEffect, createSignal, onSettled } from "solid-js";

export type ThemePreference = "system" | "light" | "dark";
const key = "pi-web.theme.v1";

/** Tracks a browser media query and releases its listener with the owning view. */
export function createMediaQuery(query: string) {
  const media = window.matchMedia(query);
  const [matches, setMatches] = createSignal(media.matches);
  onSettled(() => {
    const changed = () => setMatches(media.matches);
    media.addEventListener("change", changed);
    changed();
    return () => media.removeEventListener("change", changed);
  });
  return matches;
}

/** Applies a saved light/dark preference, or follows the OS while set to system.
 * Storage failures leave the choice usable for the lifetime of this page.
 */
export function createTheme() {
  let saved: ThemePreference = "system";
  try {
    const value = window.localStorage.getItem(key);
    if (value === "light" || value === "dark") saved = value;
  } catch { /* Private browsing may deny access to storage. */ }
  const [preference, setPreference] = createSignal<ThemePreference>(saved);
  const systemDark = createMediaQuery("(prefers-color-scheme: dark)");
  createEffect(() => preference() === "dark" || (preference() === "system" && systemDark()),
    dark => { document.documentElement.classList.toggle("dark", dark); });
  return {
    preference,
    setPreference(value: ThemePreference) {
      setPreference(value);
      try { window.localStorage.setItem(key, value); } catch { /* Keep the in-memory choice. */ }
    },
  };
}
