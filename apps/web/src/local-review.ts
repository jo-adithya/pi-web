import { createSignal } from "solid-js";
import { createStructuralReview, type StructuralLoader } from "./structural-review";
import { createContextReview, type ContextLoader } from "./context-review";
import { commitId, createCommitHistory, type CommitLoader } from "./commit-review";
import { createBranchList, type BranchLoader } from "./branch-review";
import { createReviewGroups, type GroupInput, type GroupLoader } from "./review-groups";
import type { GroupModel } from "./review-costs";

export type ReviewScope = "unstaged" | "staged" | "branch" | "commit";
export interface ReviewRequest { scope: ReviewScope; base?: string; commit?: string }
export interface ReviewLoadRequest extends ReviewRequest { path?: string; cursor?: string }
export interface ReviewEntry { path: string; previousPath: string | null; status: string; patch: string | null; fingerprint: string | null }
export interface ReviewFile extends ReviewEntry { patch: string; fingerprint: string }
/** Scope-wide Git counts, including files omitted by display limits; unavailable files have no numeric count. */
export interface ReviewLineStats { added: number; removed: number; unavailableFiles: number }
export interface ReviewSnapshot { files: ReviewEntry[]; truncated: boolean; note: string | null; lineStats?: ReviewLineStats; nextCursor?: string; snapshotKey?: string }
/** Only loaded patches can be used by context, structural review and Ask Pi. */
export const hasPatch = (file: ReviewEntry): file is ReviewFile => file.patch !== null && file.fingerprint !== null;
const statuses = new Set(["added", "deleted", "renamed", "copied", "typechanged", "unmerged", "modified", "untracked"]);

/** Reads bounded metadata or one selected patch using the session capability. */
export async function fetchReview(id: string, request: ReviewLoadRequest, signal: AbortSignal, capability: string | null): Promise<ReviewSnapshot> {
  if (!capability) throw new Error("Authentication required. Reopen the current terminal URL.");
  const response = await fetch(`/review/${encodeURIComponent(id)}`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal,
    headers: { "content-type": "application/json", "x-pi-capability": capability }, body: JSON.stringify(request),
  });
  if (response.status === 422) {
    const failure: unknown = await response.json();
    if (failure && typeof failure === "object" && "error" in failure && typeof failure.error === "string" && failure.error.length <= 256) throw new Error(failure.error);
  }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Authentication required. Reopen the current terminal URL." : "Local review unavailable. Check that this workspace is a Git root and the base is a valid local ref, then retry.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("files" in value) || !Array.isArray(value.files) || value.files.length > 100 ||
      !("truncated" in value) || typeof value.truncated !== "boolean" || !("note" in value) || (value.note !== null && typeof value.note !== "string")) throw new Error("Invalid local review response.");
  if ("nextCursor" in value && (typeof value.nextCursor !== "string" || !value.nextCursor || value.nextCursor.length > 256 || request.path !== undefined || !value.files.length)) throw new Error("Invalid review continuation.");
  if ("snapshotKey" in value && (typeof value.snapshotKey !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotKey))) throw new Error("Invalid review snapshot identity.");
  let lineStats: ReviewLineStats | undefined;
  if ("lineStats" in value) {
    const stats = value.lineStats;
    const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (!stats || typeof stats !== "object" || !("added" in stats) || !count(stats.added) ||
        !("removed" in stats) || !count(stats.removed) || !("unavailableFiles" in stats) || !count(stats.unavailableFiles) ||
        !Number.isSafeInteger(stats.added + stats.removed)) throw new Error("Invalid review line totals.");
    lineStats = { added: stats.added, removed: stats.removed, unavailableFiles: stats.unavailableFiles };
  }
  let bytes = 0;
  const files: ReviewEntry[] = value.files.map((file: unknown) => {
    if (!file || typeof file !== "object" || !("path" in file) || typeof file.path !== "string" || !file.path ||
        !("previousPath" in file) || (file.previousPath !== null && typeof file.previousPath !== "string") ||
        !("status" in file) || typeof file.status !== "string" || !statuses.has(file.status) || !("patch" in file) || (file.patch !== null && typeof file.patch !== "string") ||
        !("fingerprint" in file) || (file.fingerprint !== null && (typeof file.fingerprint !== "string" || !file.fingerprint || file.fingerprint.length > 128)) ||
        (file.patch === null) !== (file.fingerprint === null)) throw new Error("Invalid local review response.");
    const size = new TextEncoder().encode(file.patch ?? "").length; bytes += size;
    if (size > 65536 || bytes > 1_100_000) throw new Error("Local review response exceeds its limit.");
    return { path: file.path, previousPath: file.previousPath, status: file.status, patch: file.patch, fingerprint: file.fingerprint };
  });
  if (request.path !== undefined && (files.length !== 1 || files[0].path !== request.path || !hasPatch(files[0]))) throw new Error("Invalid selected-file response.");
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("Duplicate review files.");
  return { files, truncated: value.truncated, note: value.note, ...("snapshotKey" in value ? { snapshotKey: value.snapshotKey as string } : {}), ...(lineStats ? { lineStats } : {}), ...("nextCursor" in value ? { nextCursor: value.nextCursor as string } : {}) };
}

/** Session-local lazy patches with a 1 MiB LRU budget. Refresh discards loaded content;
 * reviewed fingerprints are revalidated as files load. Cancellation ignores late replies.
 */
export function createLocalReview(load: (request: ReviewLoadRequest, signal: AbortSignal) => Promise<ReviewSnapshot>, loadStructural: StructuralLoader = async () => ({ mode: "text", reason: "Structural comparison is unavailable." }), loadContext: ContextLoader = async () => { throw new Error("Diff context is unavailable."); }, loadCommits: CommitLoader = async () => { throw new Error("Commit history is unavailable."); }, loadGroups: GroupLoader = async () => { throw new Error("AI grouping is unavailable."); }, loadBranches: BranchLoader = async () => { throw new Error("Branch list is unavailable."); }, groupingConfig: { model?: () => GroupModel | null; cacheNamespace?: string } = {}) {
  const grouping = createReviewGroups(loadGroups, groupingConfig.cacheNamespace);
  const groupingModel = () => grouping.options().model ?? groupingConfig.model?.();
  // Budget changes affect work allowed, not the identity of already completed suggestions.
  const cacheKey = (source: ReviewSnapshot, request: ReviewRequest) => source.snapshotKey && groupingModel()
    ? JSON.stringify(["group-v3", request, source.snapshotKey, groupingModel(), grouping.options().includeGenerated]) : undefined;
  const structural = createStructuralReview(loadStructural);
  const context = createContextReview(loadContext);
  const [scope, setScope] = createSignal<ReviewScope>("unstaged");
  const [base, setBase] = createSignal("");
  const [commit, setCommit] = createSignal("");
  const history = createCommitHistory(loadCommits);
  const branches = createBranchList(loadBranches);
  const [snapshot, setSnapshot] = createSignal<ReviewSnapshot>();
  const [target, setTarget] = createSignal<ReviewRequest>();
  const [selected, updateSelected] = createSignal("");
  const [reviewed, setReviewed] = createSignal(new Map<string, string>());
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const [patchBusy, setPatchBusy] = createSignal(false), [patchError, setPatchError] = createSignal("");
  let controller: AbortController | undefined, patchController: AbortController | undefined;
  const recent = new Map<string, number>();
  const isReviewed = (file: ReviewEntry) => file.fingerprint !== null && reviewed().get(file.path) === file.fingerprint;
  function mark(file: ReviewEntry, checked: boolean) {
    if (!hasPatch(file)) return;
    setReviewed(previous => { const next = new Map(previous); if (checked) next.set(file.path, file.fingerprint); else next.delete(file.path); return next; });
  }
  function cancelPatch() { patchController?.abort(); patchController = undefined; setPatchBusy(false); }
  function cancel() { controller?.abort(); controller = undefined; history.cancel(); branches.cancel(); cancelPatch(); grouping.cancel(); setBusy(false); structural.reset(); context.reset(); }
  function setSelected(path: string) {
    cancelPatch(); structural.reset(); context.reset(); updateSelected(path); setPatchError("");
    if (!busy()) void loadPatch(path);
  }
  /** Loads only an uncached selected file. Metadata remains visible during reads or errors. */
  async function loadPatch(path = selected(), source = snapshot(), request = target()) {
    cancelPatch(); setPatchError("");
    const entry = source?.files.find(file => file.path === path);
    if (!source || !request || !entry) return;
    if (hasPatch(entry)) {
      const size = recent.get(path) ?? new TextEncoder().encode(entry.patch).length;
      recent.delete(path); recent.set(path, size); return;
    }
    const current = new AbortController(); patchController = current; setPatchBusy(true);
    try {
      const result = await load({ ...request, path }, current.signal);
      if (patchController !== current) return;
      const file = result.files[0];
      if (result.files.length !== 1 || !file || file.path !== path || !hasPatch(file)) throw new Error("Invalid selected-file response.");
      grouping.observe(path, file.fingerprint);
      recent.delete(path); recent.set(path, new TextEncoder().encode(file.patch).length);
      let total = [...recent.values()].reduce((sum, size) => sum + size, 0);
      const evicted = new Set<string>();
      for (const [key, size] of recent) {
        if (total <= 1024 * 1024) break;
        recent.delete(key); evicted.add(key); total -= size;
      }
      setSnapshot(previous => previous ? { ...previous, files: previous.files.map(item => item.path === path ? file : evicted.has(item.path) ? { ...item, patch: null } : item) } : previous);
    } catch (reason) {
      if (patchController === current) setPatchError(reason instanceof Error ? reason.message : "Could not load patch. Retry.");
    } finally { if (patchController === current) { patchController = undefined; setPatchBusy(false); } }
  }
  /** Pins commit reviews to a full object ID, independent of subsequent HEAD/history changes. */
  async function refresh(nextScope: ReviewScope = scope(), nextCommit = commit()) {
    const previousTarget = target();
    cancel();
    if (snapshot()) grouping.reconcile(undefined, snapshot()!.files, true); else grouping.reset();
    setError(""); setPatchError("");
    const current = new AbortController(); controller = current; setBusy(true);
    try {
      if (nextScope === "commit" && !nextCommit) {
        const list = history.value() ?? await history.refresh();
        if (controller !== current) return;
        if (!list) return;
        nextCommit = list.commits[0]?.id ?? ""; setCommit(nextCommit);
        if (!nextCommit) { setSnapshot(undefined); setTarget(undefined); setReviewed(new Map()); updateSelected(""); return; }
      }
      const request: ReviewRequest = nextScope === "branch" ? { scope: "branch", base: base().trim() } : nextScope === "commit" ? { scope: "commit", commit: nextCommit } : { scope: nextScope };
      if (request.scope === "branch" && !request.base) { setError("Enter a local base branch or tag."); return; }
      if (request.scope === "commit" && !commitId(nextCommit)) { setError("Choose a local commit."); return; }
      if (JSON.stringify(request) !== JSON.stringify(target())) { setSnapshot(undefined); setReviewed(new Map()); updateSelected(""); }
      setTarget(request);
      // Admit a complete metadata list atomically. A stale continuation leaves the old review intact.
      let result = await load(request, current.signal);
      if (controller !== current) return;
      const paths = new Set(result.files.map(file => file.path)), cursors = new Set<string>();
      while (result.nextCursor) {
        const cursor = result.nextCursor;
        if (cursors.has(cursor)) throw new Error("Repeated review continuation. Refresh and try again.");
        if (result.files.length >= 10000) throw new Error("Review exceeds 10,000 files. Choose a smaller scope.");
        cursors.add(cursor);
        const page = await load({ ...request, cursor }, current.signal);
        if (controller !== current) return;
        if (result.files.length + page.files.length > 10000) throw new Error("Review exceeds 10,000 files. Choose a smaller scope.");
        for (const file of page.files) {
          if (paths.has(file.path)) throw new Error("File listing changed. Refresh and try again.");
          paths.add(file.path);
        }
        result = { ...result, files: [...result.files, ...page.files], nextCursor: page.nextCursor, truncated: result.truncated || page.truncated, note: result.note ?? page.note };
      }
      recent.clear();
      setReviewed(previous => new Map([...previous].filter(([path]) => result.files.some(file => file.path === path))));
      setSnapshot(result);
      grouping.reconcile(cacheKey(result, request), result.files, JSON.stringify(request) === JSON.stringify(previousTarget));
      const path = result.files.some(file => file.path === selected()) ? selected() : result.files[0]?.path ?? "";
      updateSelected(path);
      // List admission and patch admission have independent lifetimes; navigation can cancel a patch.
      controller = undefined; setBusy(false);
      await loadPatch(path, result, request);
    } catch (reason) {
      if (controller === current) {
        setError(reason instanceof Error ? reason.message : "Local review unavailable. Retry refresh.");
        controller = undefined; setBusy(false);
        // A selection made during refresh still needs its patch from the retained list.
        await loadPatch();
      }
    } finally { if (controller === current) { controller = undefined; setBusy(false); } }
  }
  /** Groups the full metadata snapshot, capturing only model-selected diffs.
   * Selection and the UI cache stay unchanged. Mutable content is captured best-effort on demand.
   */
  async function groupWithAI(force = false) {
    const source = snapshot(), request = target();
    if (!source || !request || busy()) return;
    // local_review.rs uses these notices for admitted files without readable diffs.
    const omitted = new Set([
      "Untracked content omitted; file has not been read.\n", "Binary content omitted.\n",
      "Non-UTF-8 patch omitted.\n", "Patch exceeds 64 KiB; content omitted.\n",
    ]);
    const input = (file: ReviewEntry): GroupInput => ({ path: file.path, status: file.status,
      patch: omitted.has(file.patch ?? "") ? null : file.patch, fingerprint: file.fingerprint, uncaptured: !hasPatch(file) });
    const metadata = source.files.map(input);
    await grouping.run(async () => metadata, async (path, signal) => {
      const result = await load({ ...request, path }, signal), file = result.files[0];
      if (result.files.length !== 1 || !file || file.path !== path) throw new Error("Invalid selected-file response.");
      return { ...input(file), uncaptured: false };
    }, { cacheKey: cacheKey(source, request), force, model: groupingModel() ?? undefined,
      verify: source.snapshotKey ? async signal => (await load(request, signal)).snapshotKey === source.snapshotKey : undefined });
  }

  return { scope, setScope, base, setBase, commit, setCommit, history, branches, snapshot, target, selected, setSelected, busy, error, patchBusy, patchError, loadPatch, refresh, cancel, isReviewed, mark, structural, context, grouping, groupWithAI };
}
export type LocalReviewModel = ReturnType<typeof createLocalReview>;

export interface DiffLine { text: string; kind: "header" | "context" | "add" | "remove"; old?: number; next?: number }
/** Adds old/new line numbers only inside unified hunks; metadata and binary notices stay plain text. */
export function diffLines(patch: string): DiffLine[] {
  let old = 0, next = 0, inHunk = false;
  return patch.replace(/\n$/, "").split("\n").map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; return { text, kind: "header" }; }
    if (inHunk && text.startsWith("+")) return { text, kind: "add", next: next++ };
    if (inHunk && text.startsWith("-")) return { text, kind: "remove", old: old++ };
    if (inHunk && text.startsWith(" ")) return { text, kind: "context", old: old++, next: next++ };
    if (!text.startsWith("\\")) inHunk = false;
    return { text, kind: "header" };
  });
}

/** Appends a full patch or selected source rows to an unsent draft. Excerpts retain
 * old/new coordinates and diff prefixes; the 32 KiB limit rejects without losing text.
 */
export function reviewDraft(draft: string, file: ReviewFile, target: ReviewRequest, lines?: readonly DiffLine[]): string {
  const scope = target.scope === "commit" ? `commit ${target.commit} against its first parent (empty tree for a root commit)` : target.scope === "branch" ? `branch changes against merge-base with ${JSON.stringify(target.base)}` : target.scope;
  const excerpt = lines ? `Selected lines only (not a complete diff). Old/new are source line numbers; — means absent on that side.\n${lines.map(line => `old ${line.old ?? "—"} | new ${line.next ?? "—"} | ${line.text}`).join("\n")}` : file.patch;
  const context = `Review the local ${scope} changes for ${JSON.stringify(file.path)}. This is a snapshot; verify the current file before proposing changes.\n\n${excerpt}`;
  const result = draft ? `${draft}\n\n${context}` : context;
  if (new TextEncoder().encode(result).length > 32768) throw new Error("This patch and your draft exceed the message limit. Select fewer lines or shorten your draft.");
  return result;
}
