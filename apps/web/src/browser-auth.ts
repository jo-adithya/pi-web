/** Capability storage is isolated by scheme/host/port and tab, unlike cookies.
 * Only the current origin's WebSocket handshake receives this explicit proof.
 */
export const CAPABILITY_KEY = "pi-web.capability.v1";
export const SOCKET_PROTOCOL = "pi-web.v1";

/** Validates the server's 256-bit lowercase hexadecimal bootstrap credential. */
export function isCapability(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Parses a same-origin terminal URL, #cap fragment, or raw token; returns null for invalid input. */
export function capabilityFromLink(value: string): string | null {
  if (isCapability(value.trim())) return value.trim();
  const input = value.trim();
  try {
    const url = input.startsWith("#") ? new URL(input, location.origin) : new URL(input);
    const values = new URLSearchParams(url.hash.slice(1)).getAll("cap");
    if (url.origin !== location.origin || url.username || url.password || url.pathname !== "/" || url.search || values.length !== 1) return null;
    return isCapability(values[0]) ? values[0] : null;
  } catch { return null; }
}

/** Returns a valid tab-local credential, or null when absent/blocked/malformed. */
export function loadCapability(): string | null {
  try { const value = sessionStorage.getItem(CAPABILITY_KEY); return isCapability(value) ? value : null; }
  catch { return null; }
}

/** Persists or removes the credential; false means the UI must disclose memory-only use. */
export function saveCapability(value: string | null): boolean {
  try {
    if (value === null) sessionStorage.removeItem(CAPABILITY_KEY);
    else sessionStorage.setItem(CAPABILITY_KEY, value);
    return true;
  } catch { return false; }
}
