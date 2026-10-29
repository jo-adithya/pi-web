/** Capability storage is isolated by scheme/host/port and tab, unlike cookies.
 * Only the current origin's WebSocket handshake receives this explicit proof.
 */
export const CAPABILITY_KEY = "pi-web.capability.v1";
export const SOCKET_PROTOCOL = "pi-web.v1";

/** Validates the server's 256-bit lowercase hexadecimal bootstrap credential. */
export function isCapability(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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
