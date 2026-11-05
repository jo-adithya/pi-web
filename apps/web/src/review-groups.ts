import { createSignal } from "solid-js";

export interface GroupInput { path: string; patch: string | null; fingerprint?: string | null }
export interface IntentGroup { title: string; reason: string; paths: string[] }
export interface GroupRequest { files: { path: string; patch: string | null }[] }
export type GroupLoader = (request: GroupRequest, signal: AbortSignal) => Promise<unknown>;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** Model text is display-only. Unknown/duplicate paths reject the result; omissions stay visible. */
export function normalizeGroups(value: unknown, files: GroupInput[]): IntentGroup[] {
  if (!value || typeof value !== "object" || !("groups" in value) || !Array.isArray(value.groups) || value.groups.length > 20) throw new Error("Invalid AI grouping response.");
  const allowed = new Set(files.map(file => file.path)), seen = new Set<string>();
  const groups = value.groups.map((item: unknown): IntentGroup => {
    if (!item || typeof item !== "object" || !("title" in item) || typeof item.title !== "string" || !item.title.trim() || [...item.title].length > 80 || !("reason" in item) || typeof item.reason !== "string" || [...item.reason].length > 240 || !("paths" in item) || !Array.isArray(item.paths) || !item.paths.length || item.paths.length > files.length) throw new Error("Invalid AI grouping response.");
    const paths = item.paths.map((path: unknown) => {
      if (typeof path !== "string" || !allowed.has(path) || seen.has(path)) throw new Error("AI grouping returned unknown or repeated files.");
      seen.add(path); return path;
    });
    return { title: item.title, reason: item.reason, paths };
  });
  const remaining = files.filter(file => !seen.has(file.path)).map(file => file.path);
  if (remaining.length) groups.push({ title: "Ungrouped", reason: "Not assigned by the model.", paths: remaining });
  return groups;
}

/** Sends only explicitly gathered snippets to the server's tool-disabled analysis session. */
export async function fetchReviewGroups(id: string, request: GroupRequest, signal: AbortSignal, capability: string | null): Promise<unknown> {
  if (!capability) throw new Error("Authentication required. Reopen the current terminal URL.");
  const body = JSON.stringify(request);
  if (bytes(body) > 192 * 1024) throw new Error("File names and snippets exceed the AI grouping request limit.");
  const response = await fetch(`/review/${encodeURIComponent(id)}/groups`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(70000)]),
    headers: { "content-type": "application/json", "x-pi-capability": capability }, body,
  });
  if (response.status === 401 || response.status === 403) throw new Error("Authentication required. Reopen the current terminal URL.");
  if (response.status === 429) throw new Error("AI grouping is busy. Try again shortly.");
  const text = await response.text();
  if (bytes(text) > 192 * 1024) throw new Error("AI grouping response exceeds its limit.");
  const value: unknown = JSON.parse(text);
  if (!response.ok) {
    if (value && typeof value === "object" && "error" in value && typeof value.error === "string" && value.error.length <= 256) throw new Error(value.error);
    throw new Error("AI grouping failed. Folder grouping is still available.");
  }
  return value;
}

/** Clips at Unicode character boundaries; source text never becomes rendered markup. */
function snippet(text: string, limit: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= limit) return text;
  // Streaming decode retains an incomplete final code point instead of replacing it.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoded.subarray(0, limit), { stream: true });
}

/** Opt-in, session-local suggestions. Reset invalidates late replies and all snapshot-bound results. */
export function createReviewGroups(load: GroupLoader) {
  const [value, setValue] = createSignal<IntentGroup[]>();
  const [mode, setMode] = createSignal<"folders" | "intent">("folders");
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal(""), [notice, setNotice] = createSignal("");
  let active: AbortController | undefined;
  let fingerprints = new Map<string, string>();
  const observed = new Map<string, string>();
  function cancel() { active?.abort(); active = undefined; setBusy(false); }
  function reset() { cancel(); fingerprints.clear(); observed.clear(); setValue(undefined); setMode("folders"); setError(""); setNotice(""); }
  function observe(path: string, fingerprint: string) {
    if (active) observed.set(path, fingerprint);
    if (fingerprints.has(path) && fingerprints.get(path) !== fingerprint) reset();
  }
  async function run(prepare: (signal: AbortSignal) => Promise<GroupInput[]>) {
    reset(); const current = new AbortController(); active = current; setBusy(true);
    const timer = setTimeout(() => current.abort(), 90000);
    try {
      const files = await prepare(current.signal);
      if (active !== current || current.signal.aborted) return;
      if (!files.length || files.length > 100) throw new Error("Choose a nonempty review snapshot first.");
      if (files.some(file => file.fingerprint && observed.has(file.path) && observed.get(file.path) !== file.fingerprint)) throw new Error("A patch changed while preparing AI grouping. Refresh and try again.");
      let budget = 48 * 1024, count = 0, partial = false;
      const bounded = files.map(file => {
        const patch = file.patch !== null && count < 20 && budget > 0 ? snippet(file.patch, Math.min(8192, budget)) : null;
        if (patch !== null) { count++; budget -= bytes(patch); }
        if (patch === null || patch !== file.patch) partial = true;
        return { path: file.path, patch };
      });
      fingerprints = new Map(files.flatMap(file => file.fingerprint ? [[file.path, file.fingerprint] as const] : []));
      const result = await load({ files: bounded }, current.signal);
      if (active !== current || current.signal.aborted) return;
      const groups = normalizeGroups(result, files);
      setValue(groups); setMode("intent");
      setNotice(partial ? `AI suggestions use partial context: ${count} of ${files.length} file snippets, up to 8 KiB each / 48 KiB total. Verify the grouping.` : "AI suggestions for this snapshot. Verify the grouping.");
    } catch (reason) {
      if (active === current) setError(current.signal.aborted ? "AI grouping timed out. Try again." : reason instanceof Error ? reason.message : "AI grouping failed.");
    } finally { clearTimeout(timer); if (active === current) { active = undefined; setBusy(false); } }
  }
  return { value, mode, setMode, busy, error, notice, run, cancel, reset, observe };
}
