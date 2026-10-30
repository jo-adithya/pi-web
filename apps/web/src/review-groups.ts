import { createSignal } from "solid-js";
import { accountResponse, createGroupCache, emptyUsage, noisyFile, type GroupOptions, type GroupModel } from "./review-costs";

export interface GroupInput {
  path: string; status: string; patch: string | null; fingerprint?: string | null;
  /** True until captured on demand; otherwise a null patch means unavailable content. */
  uncaptured?: boolean;
}
export interface IntentGroup { title: string; reason: string; paths: string[] }
interface FileOverview { path: string; status: string; patch: string | null; added: number; removed: number; patchLines: number | null; sampled: boolean }
interface DiffRead { path: string; startLine: number }
interface DiffDetail extends DiffRead { patch: string }
export interface GroupRequest { files: FileOverview[]; details: DiffDetail[]; readsRemaining: number; model?: GroupModel }
export interface GroupRun { cacheKey?: string; force?: boolean; model?: GroupModel; verify?: (signal: AbortSignal) => Promise<boolean> }
export interface GroupCoverage { files: number; sampled: number; unavailable: number; metadata: number; reads: number; bytes: number }
const overviewLimit = 24 * 1024, contextLimit = 48 * 1024;
export type GroupLoader = (request: GroupRequest, signal: AbortSignal) => Promise<unknown>;
/** Prepares copied metadata and any already cached patches; uncaptured patches are read only on demand. */
export type GroupPreparation = (signal: AbortSignal) => Promise<GroupInput[]>;
export type GroupReader = (path: string, signal: AbortSignal) => Promise<GroupInput>;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** Model text is display-only. Unknown/duplicate paths reject the result; omissions stay visible. */
export function normalizeGroups(value: unknown, files: GroupInput[]): IntentGroup[] {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !("groups" in value) || !Array.isArray(value.groups) || value.groups.length > 20) throw new Error("Invalid AI grouping response.");
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

/** Sends one bounded reasoning round to an isolated, tool-disabled model session. */
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

/** Summarizes every captured patch, sampling up to three evenly spaced hunks rather than a prefix. */
function overview(file: GroupInput, limit: number): FileOverview {
  if (file.uncaptured) return { path: file.path, status: file.status, patch: null, added: 0, removed: 0, patchLines: null, sampled: true };
  if (file.status === "summary") return { path: file.path, status: file.status, patch: snippet(file.patch ?? "", limit), added: 0, removed: 0, patchLines: 0, sampled: true };
  const lines = file.patch ? file.patch.replace(/\n$/, "").split("\n") : [];
  const hunks: number[] = [];
  let added = 0, removed = 0, inHunk = false;
  lines.forEach((line, index) => {
    if (line.startsWith("@@ ")) { hunks.push(index); inHunk = true; }
    else if (inHunk && line.startsWith("+")) added++;
    else if (inHunk && line.startsWith("-")) removed++;
    else if (!line.startsWith(" ") && !line.startsWith("\\")) inHunk = false;
  });
  let patch = file.patch, sampled = false;
  if (patch !== null && limit === 0) return { path: file.path, status: file.status, patch: "", added, removed, patchLines: lines.length, sampled: true };
  if (patch !== null) {
    const full = `Diff lines 1–${lines.length}:\n${patch}`;
    sampled = bytes(full) > limit;
    if (!sampled) patch = full;
    else {
      const starts = hunks.length ? [...new Set([hunks[0], hunks[Math.floor(hunks.length / 2)], hunks[hunks.length - 1]])] : [0];
      const allowance = Math.floor((limit - starts.length) / starts.length);
      patch = starts.map(start => {
        const end = hunks.find(index => index > start) ?? lines.length;
        const changed = lines.findIndex((line, index) => index > start && index < end && /^[+-]/.test(line));
        const body = changed < 0 ? start + 1 : Math.max(start + 1, changed - 1);
        return snippet(`Diff line ${start + 1}: ${lines[start]}\nDiff lines ${body + 1}+:\n${lines.slice(body, Math.min(end, body + 8)).join("\n")}`, allowance);
      }).join("\n");
    }
  }
  return { path: file.path, status: file.status, patch, added, removed, patchLines: lines.length, sampled };
}

/** Validates model-selected diff coordinates against this request's allowlist and consumed reads. */
function requestedDiffs(value: unknown, request: GroupRequest): DiffRead[] | undefined {
  if (!value || typeof value !== "object" || !("readDiffs" in value)) return undefined;
  if (!request.readsRemaining) throw new Error("AI requested more context after the retrieval limit. Try grouping again.");
  if (Object.keys(value).length !== 1 || !Array.isArray(value.readDiffs) || !value.readDiffs.length || value.readDiffs.length > Math.min(4, request.readsRemaining)) throw new Error("Invalid AI diff request.");
  const seen = new Set(request.details.map(detail => JSON.stringify([detail.path, detail.startLine])));
  return value.readDiffs.map((item: unknown) => {
    if (!item || typeof item !== "object" || Object.keys(item).length !== 2 || !("path" in item) || typeof item.path !== "string" || !("startLine" in item) || typeof item.startLine !== "number" || !Number.isInteger(item.startLine)) throw new Error("Invalid AI diff request.");
    const file = request.files.find(file => file.path === item.path), key = JSON.stringify([item.path, item.startLine]);
    if (!file || item.startLine < 1 || (file.patchLines === null ? item.startLine !== 1 : file.patch === null || item.startLine > file.patchLines) || seen.has(key)) throw new Error("AI requested an unknown, repeated or out-of-range diff excerpt.");
    seen.add(key); return { path: item.path, startLine: item.startLine };
  });
}

/** Whole-change suggestions with bounded selective reads and recursive summary reconciliation.
 * Each inference unit has a 90-second deadline. Only a complete global result is published.
 * Captured mutable diffs form a best-effort snapshot; observed fingerprint changes invalidate it.
 */
export function createReviewGroups(load: GroupLoader, cacheNamespace?: string) {
  const cache = createGroupCache(cacheNamespace);
  const [options, updateOptions] = createSignal<GroupOptions>({ maxCalls: 6, maxRequestBytes: 512 * 1024, includeGenerated: false });
  const [usage, setUsage] = createSignal(emptyUsage());
  const [stale, setStale] = createSignal(false);
  function setOptions(next: GroupOptions) {
    if (busy()) return;
    updateOptions(next);
    if (value()) { setStale(true); setNotice("Grouping settings changed. Update groups when ready; no AI call has been made."); }
  }
  const [value, setValue] = createSignal<IntentGroup[]>();
  const [mode, setMode] = createSignal<"folders" | "intent">("folders");
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal(""), [notice, setNotice] = createSignal("");
  const [progress, setProgress] = createSignal("");
  const [coverage, setCoverage] = createSignal<GroupCoverage>();
  const [details, setDetails] = createSignal<DiffRead[]>([]);
  let active: AbortController | undefined;
  let fingerprints = new Map<string, string>();
  const observed = new Map<string, string>();
  function cancel() { active?.abort(); active = undefined; setBusy(false); setProgress(""); }
  function reset() { cancel(); fingerprints.clear(); observed.clear(); setValue(undefined); setMode("folders"); setError(""); setNotice(""); setCoverage(undefined); setDetails([]); setStale(false); }
  /** Restores only exact content/model matches; otherwise keeps old suggestions explicitly stale with new files ungrouped. */
  function reconcile(key: string | undefined, files: GroupInput[], retain = false) {
    cancel(); fingerprints.clear(); observed.clear();
    const saved = key ? cache.get(key, files) : undefined;
    if (saved) { setValue(saved); setMode("intent"); setStale(false); setUsage({ ...emptyUsage(), reused: true }); setNotice("Reused groups for unchanged content. No AI call."); }
    else if (retain && value()) {
      const allowed = new Set(files.map(file => file.path));
      const groups = value()!.map(group => ({ ...group, paths: group.paths.filter(path => allowed.has(path)) })).filter(group => group.paths.length);
      // Retained navigation may contain twenty model groups plus our own remainder.
      // It is already validated; only new model responses use the twenty-group cap.
      const assigned = new Set(groups.flatMap(group => group.paths));
      const remaining = files.filter(file => !assigned.has(file.path)).map(file => file.path);
      if (remaining.length) {
        const ungrouped = groups.find(group => group.title === "Ungrouped" && group.reason === "Not assigned by the model.");
        if (ungrouped) ungrouped.paths.push(...remaining);
        else groups.push({ title: "Ungrouped", reason: "Not assigned by the model.", paths: remaining });
      }
      setValue(groups); setStale(true);
      setNotice("Changes may have moved on. These are previous groups; update them when ready. No automatic AI calls.");
    } else reset();
  }
  function observe(path: string, fingerprint: string) {
    if (active) observed.set(path, fingerprint);
    if (fingerprints.has(path) && fingerprints.get(path) !== fingerprint) {
      cancel(); setStale(true); setNotice("An analyzed file changed. Previous groups remain for navigation; update them when ready.");
    }
  }
  async function run(prepare: GroupPreparation, read?: GroupReader, reuse: GroupRun = {}) {
    const settings = { ...options(), model: reuse.model ?? options().model };
    reset(); setUsage(emptyUsage()); const current = new AbortController(); active = current; setBusy(true); setProgress("Preparing file overview…");
    let timer = setTimeout(() => current.abort(), 90000), calls = 0, reconciled = false;
    const totals: GroupCoverage = { files: 0, sampled: 0, unavailable: 0, metadata: 0, reads: 0, bytes: 0 };
    const allReads: DiffRead[] = [], omitted: string[] = [];
    function check() {
      if (active !== current || current.signal.aborted) throw new Error("AI grouping cancelled or timed out.");
    }
    function capture(file: GroupInput) {
      if (file.fingerprint) {
        if ((observed.has(file.path) && observed.get(file.path) !== file.fingerprint) ||
            (fingerprints.has(file.path) && fingerprints.get(file.path) !== file.fingerprint)) throw new Error("A patch changed while preparing AI grouping. Refresh and try again.");
        fingerprints.set(file.path, file.fingerprint);
      }
    }
    const bodySize = (files: FileOverview[], details: DiffDetail[] = []) => bytes(JSON.stringify({ files, details, readsRemaining: 8 }));
    /** Partitions serialized metadata, reserving room for snippets and escaped detail text. */
    function partition(files: GroupInput[]): GroupInput[][] {
      const chunks: GroupInput[][] = []; let chunk: GroupInput[] = [], size = bodySize([]);
      for (const file of files) {
        const cost = bytes(JSON.stringify(overview({ ...file, patch: null }, 0))) + 1;
        if (chunk.length && (chunk.length === 1000 || size + cost > 128 * 1024)) { chunks.push(chunk); chunk = []; size = bodySize([]); }
        if (size + cost > 128 * 1024) throw new Error("File names exceed the AI grouping request limit.");
        chunk.push(file); size += cost;
      }
      if (chunk.length) chunks.push(chunk);
      return chunks;
    }
    /** Owns at most eight newly captured patches, released after this unit's reasoning rounds. */
    async function infer(files: GroupInput[]): Promise<{ groups: IntentGroup[]; missing: string[] }> {
      check(); clearTimeout(timer); timer = setTimeout(() => current.abort(), 90000);
      const captured = new Map<string, GroupInput>();
      let overviews = files.map(file => overview(file, Math.min(2048, Math.floor(overviewLimit / files.length))));
      // JSON escaping and metadata count toward the transport limit independently of snippet bytes.
      if (bodySize(overviews) > 160 * 1024) overviews = files.map(file => overview(file, 0));
      let used = overviews.reduce((sum, file) => sum + bytes(file.patch ?? ""), 0);
      let request: GroupRequest = { files: overviews, details: [], readsRemaining: files[0].status === "summary" ? 0 : 8, ...(settings.model ? { model: settings.model } : {}) };
      for (let round = 0; round < 3; round++) {
        check();
        const size = bytes(JSON.stringify(request));
        if (size > 192 * 1024) throw new Error("File names and snippets exceed the AI grouping request limit.");
        if (calls >= settings.maxCalls || usage().requestBytes + size > settings.maxRequestBytes) throw new Error("Grouping budget reached. Increase the limits to retry, or use folders.");
        calls++;
        setUsage(previous => ({ ...previous, calls, requestBytes: previous.requestBytes + size }));
        setProgress(`Organizing whole change · call ${calls} of ${settings.maxCalls} · ${files.length} entries`);
        const response = await load(request, current.signal); check();
        const accounted = accountResponse(response, usage()); setUsage(accounted.usage);
        const result = accounted.result;
        const reads = requestedDiffs(result, request);
        if (!reads) {
          const groups = normalizeGroups(result, files);
          // normalizeGroups appends omissions after all model groups.
          const count = result && typeof result === "object" && "groups" in result && Array.isArray(result.groups) ? result.groups.length : 0;
          if (files[0].status !== "summary") {
            totals.metadata += overviews.filter(file => file.patchLines === null).length;
            totals.sampled += overviews.filter(file => file.sampled && file.patchLines !== null).length;
            totals.unavailable += overviews.filter(file => file.patch === null && file.patchLines !== null).length;
          }
          totals.bytes += used;
          return { groups: groups.slice(0, count), missing: groups.slice(count).flatMap(group => group.paths) };
        }
        const additions: DiffDetail[] = [];
        for (const [index, selection] of reads.entries()) {
          let source = captured.get(selection.path) ?? files.find(file => file.path === selection.path)!;
          if (source.uncaptured) {
            if (!read) throw new Error("Diff capture is unavailable.");
            source = { ...await read(selection.path, current.signal) }; check();
            if (source.path !== selection.path || source.uncaptured) throw new Error("Invalid selected-file response.");
            capture(source); captured.set(source.path, source);
            const position = overviews.findIndex(file => file.path === source.path);
            // Details carry newly loaded text; metadata updates do not consume overview context.
            overviews = overviews.map((file, i) => i === position ? overview(source, 0) : file);
          }
          if (source.patch === null || source.patch === "") continue;
          const text = source.patch.split("\n").slice(selection.startLine - 1, selection.startLine + 119).join("\n");
          let allowance = Math.min(8192, Math.floor((contextLimit - used) / (reads.length - index)));
          const wireShare = Math.floor((192 * 1024 - bodySize(overviews, [...request.details, ...additions]) - 1024) / (request.readsRemaining - index));
          const coordinateBytes = bytes(JSON.stringify({ ...selection, patch: "" }));
          // Reserve a fair share for subsequent reads, including worst-case JSON escaping.
          allowance = Math.min(allowance, Math.max(0, Math.floor((wireShare - coordinateBytes) / 6)));
          let patch = snippet(text, allowance);
          // Escaped JSON can cost six bytes per source byte; fit the actual wire body.
          while (patch && bodySize(overviews, [...request.details, ...additions, { ...selection, patch }]) > 192 * 1024) {
            allowance = Math.floor(allowance / 2); patch = snippet(text, allowance);
          }
          if (!patch) throw new Error("AI diff context limit reached. Try grouping again.");
          additions.push({ ...selection, patch }); used += bytes(patch);
        }
        totals.reads += reads.length; allReads.push(...reads); setDetails([...allReads]);
        const details = [...request.details, ...additions];
        request = { ...request, files: overviews, details, readsRemaining: round === 1 || contextLimit - used < 8192 ? 0 : request.readsRemaining - reads.length };
      }
      throw new Error("AI grouping inference limit reached.");
    }
    try {
      if (!Number.isInteger(settings.maxCalls) || settings.maxCalls < 1 || settings.maxCalls > 100 || !Number.isInteger(settings.maxRequestBytes) || settings.maxRequestBytes < 1024 || settings.maxRequestBytes > 16 * 1024 * 1024) throw new Error("Invalid grouping budget.");
      const files = (await prepare(current.signal)).map(file => !settings.includeGenerated && noisyFile(file.path)
        ? { ...file, status: "generated", patch: null, uncaptured: false } : { ...file }); check();
      if (reuse.verify && !await reuse.verify(current.signal)) throw new Error("Changes have moved on. Refresh before grouping."); check();
      const saved = !reuse.force && reuse.cacheKey ? cache.get(reuse.cacheKey, files) : undefined;
      if (saved) { setValue(saved); setMode("intent"); setUsage({ ...emptyUsage(), reused: true }); setNotice("Reused groups for unchanged content. No AI call."); return; }
      if (!files.length || files.length > 10000) throw new Error("Choose a review snapshot with 1–10,000 files.");
      if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("Repeated file in AI grouping snapshot.");
      files.forEach(capture); totals.files = files.length;
      let entries = files, members = new Map(files.map(file => [file.path, [file.path]])), final: IntentGroup[] = [];
      for (let depth = 0; depth < 5; depth++) {
        const chunks = partition(entries), next: GroupInput[] = [], nextMembers = new Map<string, string[]>();
        for (const chunk of chunks) {
          const result = await infer(chunk); check();
          omitted.push(...result.missing.flatMap(path => members.get(path)!));
          if (chunks.length === 1) {
            final = result.groups.map(group => ({ ...group, paths: group.paths.flatMap(path => members.get(path)!) }));
          } else {
            reconciled = true;
            for (const group of result.groups) {
              const path = `group/${depth}-${next.length}`, originals = group.paths.flatMap(id => members.get(id)!);
              next.push({ path, status: "summary", patch: snippet(`${group.title}\n${group.reason}\nExamples: ${originals.slice(0, 3).map(path => snippet(path, 160)).join("\n")}`, 1024) });
              nextMembers.set(path, originals);
            }
          }
        }
        if (chunks.length === 1 || !next.length) break;
        if ((next.length >= entries.length && bytes(JSON.stringify(next)) >= bytes(JSON.stringify(entries))) || depth === 4) throw new Error("AI grouping summaries did not converge. Folder grouping is still available.");
        entries = next; members = nextMembers;
      }
      if (omitted.length) {
        if (final.length === 20) omitted.unshift(...final.pop()!.paths);
        final.push({ title: "Ungrouped", reason: "Not assigned by the model.", paths: omitted });
      }
      const paths = final.flatMap(group => group.paths), allowed = new Set(files.map(file => file.path));
      if (paths.length !== files.length || new Set(paths).size !== files.length || paths.some(path => !allowed.has(path))) throw new Error("Invalid global AI grouping coverage.");
      if (reuse.verify && !await reuse.verify(current.signal)) throw new Error("Changes moved during grouping. Refresh and retry; result was not cached.");
      check(); setValue(final); setMode("intent"); setCoverage(totals);
      if (reuse.cacheKey) cache.put(reuse.cacheKey, final);
      setNotice(`${totals.files} files · ${totals.metadata} metadata-only · ${totals.sampled} sampled · ${totals.unavailable} without diff · ${totals.reads} requested excerpts.${reconciled ? " Globally reconciled from bounded summaries; summary context is limited." : ""} Best-effort mutable snapshot. Suggestions, not a correctness review.`);
    } catch (reason) {
      if (active === current) setError(current.signal.aborted ? "AI grouping timed out. Try again." : reason instanceof Error ? reason.message : "AI grouping failed.");
    } finally { clearTimeout(timer); if (active === current) { active = undefined; setBusy(false); setProgress(""); } }
  }

  return { value, mode, setMode, busy, error, notice, progress, coverage, details, options, setOptions, usage, stale, reconcile, run, cancel, reset, observe };
}
