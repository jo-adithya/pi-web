import { createSignal } from "solid-js";

export interface LocalCommit { id: string; subject: string }
export interface CommitHistory { commits: LocalCommit[]; truncated: boolean }
export type CommitLoader = (signal: AbortSignal) => Promise<CommitHistory>;
/** Accepts full Git SHA-1/SHA-256 identities, excluding refs and revision expressions. */
export const commitId = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

/** Reads bounded local HEAD history; subjects are display text, never revision input. */
export async function fetchCommits(id: string, signal: AbortSignal, capability: string | null): Promise<CommitHistory> {
  if (!capability) throw new Error("Authentication required. Reopen the current terminal URL.");
  const response = await fetch(`/review/${encodeURIComponent(id)}/commits`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: { "content-type": "application/json", "x-pi-capability": capability }, body: "{}",
  });
  if (response.status === 401 || response.status === 403) throw new Error("Authentication required. Reopen the current terminal URL.");
  if (response.status === 429) throw new Error("Review workers are busy. Try again shortly.");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > 256 * 1024) throw new Error("Commit history exceeds its limit.");
  const value: unknown = JSON.parse(text);
  if (!response.ok) {
    if (value && typeof value === "object" && "error" in value && typeof value.error === "string" && value.error.length <= 256) throw new Error(value.error);
    throw new Error("Could not load local commits. Retry loading commits.");
  }
  if (!value || typeof value !== "object" || !("commits" in value) || !Array.isArray(value.commits) || value.commits.length > 100 || !("truncated" in value) || typeof value.truncated !== "boolean") throw new Error("Invalid commit history response.");
  const seen = new Set<string>();
  const commits = value.commits.map((entry: unknown): LocalCommit => {
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string" || !commitId(entry.id) || seen.has(entry.id) || !("subject" in entry) || typeof entry.subject !== "string" || [...entry.subject].length > 512 || /[\r\n\0]/.test(entry.subject)) throw new Error("Invalid commit history response.");
    seen.add(entry.id); return { id: entry.id, subject: entry.subject };
  });
  return { commits, truncated: value.truncated };
}

/** Keeps a session-local history list. Cancellation prevents stale responses replacing it. */
export function createCommitHistory(load: CommitLoader) {
  const [value, setValue] = createSignal<CommitHistory>();
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  let active: AbortController | undefined;
  function cancel() { active?.abort(); active = undefined; setBusy(false); }
  /** Replaces history on success; retains it on failure and returns undefined for failure/cancellation. */
  async function refresh(): Promise<CommitHistory | undefined> {
    cancel(); setError(""); const current = new AbortController(); active = current; setBusy(true);
    try {
      const result = await load(current.signal);
      if (active !== current) return;
      setValue(result); return result;
    } catch (reason) {
      if (active === current) setError(reason instanceof Error ? reason.message : "Could not load local commits.");
    } finally { if (active === current) { active = undefined; setBusy(false); } }
  }
  return { value, busy, error, refresh, cancel };
}
