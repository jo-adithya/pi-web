import { createSignal } from "solid-js";

export interface LocalBranch { ref: string; name: string; kind: "local" | "remote" }
export interface BranchList { branches: LocalBranch[]; truncated: boolean }
export type BranchLoader = (signal: AbortSignal) => Promise<BranchList>;

/** Lists bounded local refs, including stored remote-tracking refs, without fetching. */
export async function fetchBranches(id: string, signal: AbortSignal, capability: string | null): Promise<BranchList> {
  if (!capability) throw new Error("Authentication required. Reopen the current terminal URL.");
  const response = await fetch(`/review/${encodeURIComponent(id)}/branches`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: { "content-type": "application/json", "x-pi-capability": capability }, body: "{}",
  });
  if (response.status === 401 || response.status === 403) throw new Error("Authentication required. Reopen the current terminal URL.");
  if (response.status === 429) throw new Error("Review workers are busy. Try again shortly.");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > 64 * 1024) throw new Error("Branch list exceeds its limit.");
  const value: unknown = JSON.parse(text);
  if (!response.ok) {
    if (value && typeof value === "object" && "error" in value && typeof value.error === "string" && value.error.length <= 256) throw new Error(value.error);
    throw new Error("Could not load local branches. Retry loading branches or enter a reference.");
  }
  if (!value || typeof value !== "object" || !("branches" in value) || !Array.isArray(value.branches) || value.branches.length > 100 || !("truncated" in value) || typeof value.truncated !== "boolean") throw new Error("Invalid branch list response.");
  const seen = new Set<string>();
  const branches = value.branches.map((entry: unknown): LocalBranch => {
    if (!entry || typeof entry !== "object" || !("ref" in entry) || typeof entry.ref !== "string" || !("name" in entry) || typeof entry.name !== "string" || !entry.name || !("kind" in entry) || (entry.kind !== "local" && entry.kind !== "remote")) throw new Error("Invalid branch list response.");
    const prefix = entry.kind === "local" ? "refs/heads/" : "refs/remotes/";
    if (entry.ref !== prefix + entry.name || new TextEncoder().encode(entry.ref).length > 256 || /[\s\x00-\x1f\x7f]/.test(entry.ref) || seen.has(entry.ref)) throw new Error("Invalid branch list response.");
    seen.add(entry.ref); return { ref: entry.ref, name: entry.name, kind: entry.kind };
  });
  return { branches, truncated: value.truncated };
}

/** Session-local branch choices. Failed reloads retain choices; cancelled replies are ignored. */
export function createBranchList(load: BranchLoader) {
  const [value, setValue] = createSignal<BranchList>();
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  let active: AbortController | undefined;
  function cancel() { active?.abort(); active = undefined; setBusy(false); }
  async function refresh(): Promise<void> {
    cancel(); setError(""); const current = new AbortController(); active = current; setBusy(true);
    try {
      const result = await load(current.signal);
      if (active === current) setValue(result);
    } catch (reason) {
      if (active === current) setError(reason instanceof Error ? reason.message : "Could not load local branches.");
    } finally { if (active === current) { active = undefined; setBusy(false); } }
  }
  return { value, busy, error, refresh, cancel };
}
