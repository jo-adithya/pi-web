import { createSignal } from "solid-js";
import { createStructuralReview, type StructuralLoader } from "./structural-review";
import { createContextReview, type ContextLoader } from "./context-review";
import { commitId, createCommitHistory, type CommitLoader } from "./commit-review";
import { createReviewGroups, type GroupInput, type GroupLoader } from "./review-groups";

export type ReviewScope = "unstaged" | "staged" | "branch" | "commit";
export interface ReviewRequest { scope: ReviewScope; base?: string; commit?: string }
export interface ReviewLoadRequest extends ReviewRequest { path?: string }
export interface ReviewEntry { path: string; previousPath: string | null; status: string; patch: string | null; fingerprint: string | null }
export interface ReviewFile extends ReviewEntry { patch: string; fingerprint: string }
export interface ReviewSnapshot { files: ReviewEntry[]; truncated: boolean; note: string | null }
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
  return { files, truncated: value.truncated, note: value.note };
}

/** Session-local lazy patches with a 1 MiB LRU budget. Refresh discards loaded content;
 * reviewed fingerprints are revalidated as files load. Cancellation ignores late replies.
 */
export function createLocalReview(load: (request: ReviewLoadRequest, signal: AbortSignal) => Promise<ReviewSnapshot>, loadStructural: StructuralLoader = async () => ({ mode: "text", reason: "Structural comparison is unavailable." }), loadContext: ContextLoader = async () => { throw new Error("Diff context is unavailable."); }, loadCommits: CommitLoader = async () => { throw new Error("Commit history is unavailable."); }, loadGroups: GroupLoader = async () => { throw new Error("AI grouping is unavailable."); }) {
  const grouping = createReviewGroups(loadGroups);
  const structural = createStructuralReview(loadStructural);
  const context = createContextReview(loadContext);
  const [scope, setScope] = createSignal<ReviewScope>("unstaged");
  const [base, setBase] = createSignal("");
  const [commit, setCommit] = createSignal("");
  const history = createCommitHistory(loadCommits);
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
  function cancel() { controller?.abort(); controller = undefined; history.cancel(); cancelPatch(); grouping.cancel(); setBusy(false); structural.reset(); context.reset(); }
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
    cancel(); grouping.reset(); setError(""); setPatchError("");
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
      const result = await load(request, current.signal);
      if (controller !== current) return;
      recent.clear();
      setReviewed(previous => new Map([...previous].filter(([path]) => result.files.some(file => file.path === path))));
      setSnapshot(result);
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
  /** Explicit analysis may fetch at most 20 patches; it never changes selected files or conversation state. */
  async function groupWithAI() {
    const source = snapshot(), request = target();
    if (!source || !request || busy()) return;
    await grouping.run(async signal => {
      const files: GroupInput[] = [];
      for (const entry of source.files) {
        if (signal.aborted) throw new Error("AI grouping cancelled.");
        let file = entry;
        if (files.length < 20 && !hasPatch(file)) {
          const result = await load({ ...request, path: file.path }, signal);
          const loaded = result.files[0];
          if (result.files.length !== 1 || !loaded || loaded.path !== file.path || !hasPatch(loaded)) throw new Error("Invalid selected-file response.");
          file = loaded;
        }
        files.push({ path: file.path, patch: files.length < 20 ? file.patch : null, fingerprint: file.fingerprint });
      }
      return files;
    });
  }
  return { scope, setScope, base, setBase, commit, setCommit, history, snapshot, target, selected, setSelected, busy, error, patchBusy, patchError, loadPatch, refresh, cancel, isReviewed, mark, structural, context, grouping, groupWithAI };
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

/** Appends explicit snapshot context to an unsent draft, rejecting the prompt byte limit without losing existing text. */
export function reviewDraft(draft: string, file: ReviewFile, target: ReviewRequest): string {
  const scope = target.scope === "commit" ? `commit ${target.commit} against its first parent (empty tree for a root commit)` : target.scope === "branch" ? `branch changes against merge-base with ${JSON.stringify(target.base)}` : target.scope;
  const context = `Review the local ${scope} changes for ${JSON.stringify(file.path)}. This is a snapshot; verify the current file before proposing changes.\n\n${file.patch}`;
  const result = draft ? `${draft}\n\n${context}` : context;
  if (new TextEncoder().encode(result).length > 32768) throw new Error("This patch and your draft exceed the message limit. Ask Pi about a smaller file or shorten your draft.");
  return result;
}
