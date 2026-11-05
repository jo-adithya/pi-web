import { createSignal } from "solid-js";
import type { ReviewFile, ReviewRequest } from "./local-review";

export interface ContextRequest extends ReviewRequest { path: string; fingerprint: string; oldStart: number; newStart: number; count: number }
export interface ContextChunk { oldStart: number; newStart: number; lines: string[]; hasMore: boolean; noNewline: boolean }
export type ContextLoader = (request: ContextRequest, signal: AbortSignal) => Promise<ContextChunk>;
export interface ContextGap { id: number; index: number; remaining: number | null; above: boolean; below: boolean }
interface Hunk { header: string; suffix: string; old: number; next: number; oldCount: number; newCount: number; body: string[] }
interface Gap { old: number; next: number; total: number | null }
interface Expansion { front: string[]; back: string[]; end: boolean; noNewline: boolean }
const invalid = () => new Error("Invalid diff context response.");
const bytes = (text: string) => new TextEncoder().encode(text).length;
const lineBytes = (lines: string[]) => lines.reduce((sum, line) => sum + bytes(line) + 1, 0);

/** Fetches at most twenty unchanged lines, tied to the original file fingerprint. */
export async function fetchContextReview(id: string, request: ContextRequest, signal: AbortSignal, capability: string | null): Promise<ContextChunk> {
  if (!capability) throw new Error("Authentication required. Reopen the current terminal URL.");
  const response = await fetch(`/review/${encodeURIComponent(id)}/context`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { "content-type": "application/json", "x-pi-capability": capability }, body: JSON.stringify(request),
  });
  if (response.status === 401 || response.status === 403) throw new Error("Authentication required. Reopen the current terminal URL.");
  if (response.status === 429) throw new Error("Diff context is busy. Try again shortly.");
  const text = await response.text();
  if (bytes(text) > 65536) throw invalid();
  const value: unknown = JSON.parse(text);
  if (!response.ok) {
    if (value && typeof value === "object" && "error" in value && typeof value.error === "string" && value.error.length <= 256) throw new Error(value.error);
    throw new Error("Could not expand context. Refresh the changes and retry.");
  }
  if (!value || typeof value !== "object" || !("oldStart" in value) || value.oldStart !== request.oldStart ||
      !("newStart" in value) || value.newStart !== request.newStart || !("hasMore" in value) || typeof value.hasMore !== "boolean" ||
      !("noNewline" in value) || typeof value.noNewline !== "boolean" ||
      !("lines" in value) || !Array.isArray(value.lines) || value.lines.length > request.count ||
      value.lines.some(line => typeof line !== "string" || line.includes("\n")) || (value.hasMore && value.lines.length !== request.count) ||
      (value.noNewline && (value.hasMore || !value.lines.length))) throw invalid();
  return { oldStart: request.oldStart, newStart: request.newStart, lines: value.lines, hasMore: value.hasMore, noNewline: value.noNewline };
}

/** Parses complete ordinary hunks; metadata-only, binary and unsupported diffs have no expandable gaps. */
function parse(file: ReviewFile): { prefix: string[]; hunks: Hunk[]; gaps: Gap[] } | undefined {
  if (!["modified", "renamed", "copied"].includes(file.status)) return;
  const lines = file.patch.replace(/\n$/, "").split("\n");
  const prefix: string[] = [], hunks: Hunk[] = [];
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (match) {
      const oldCount = Number(match[2] ?? 1), newCount = Number(match[4] ?? 1);
      hunks.push({ header: line, suffix: match[5], old: Number(match[1]) + (oldCount === 0 ? 1 : 0), next: Number(match[3]) + (newCount === 0 ? 1 : 0), oldCount, newCount, body: [] });
    } else if (hunks.length) hunks[hunks.length - 1].body.push(line);
    else prefix.push(line);
  }
  if (!hunks.length) return;
  const gaps: Gap[] = [];
  let old = 1, next = 1;
  for (const hunk of hunks) {
    if (![hunk.old, hunk.next, hunk.oldCount, hunk.newCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000) ||
        hunk.body.some(line => !/^[ +\-\\]/.test(line)) ||
        hunk.body.filter(line => line[0] === " " || line[0] === "-").length !== hunk.oldCount ||
        hunk.body.filter(line => line[0] === " " || line[0] === "+").length !== hunk.newCount ||
        hunk.old < old || hunk.next - next !== hunk.old - old) return;
    gaps.push({ old, next, total: hunk.old - old });
    old = hunk.old + hunk.oldCount; next = hunk.next + hunk.newCount;
  }
  const last = hunks[hunks.length - 1].body;
  gaps.push({ old, next, total: last[last.length - 1]?.startsWith("\\") ? 0 : null });
  return { prefix, hunks, gaps };
}

/** Owns one selected file's extra context. Reset aborts requests; expanded text never mutates the review snapshot or draft. */
export function createContextReview(load: ContextLoader) {
  const [state, setState] = createSignal<{ key: string; expanded: Map<number, Expansion> }>({ key: "", expanded: new Map() });
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  let controller: AbortController | undefined;
  const key = (file: ReviewFile) => JSON.stringify([file.path, file.fingerprint]);
  const expansions = (file: ReviewFile) => state().key === key(file) ? state().expanded : new Map<number, Expansion>();
  const empty = (): Expansion => ({ front: [], back: [], end: false, noNewline: false });
  const remaining = (gap: Gap, added: Expansion) => gap.total === null ? added.end ? 0 : null : gap.total - added.front.length - added.back.length;
  function reset() {
    controller?.abort(); controller = undefined; setBusy(false); setError(""); setState({ key: "", expanded: new Map() });
  }
  /** Builds display-only hunks and gap positions, retaining original numbering and no-newline markers. */
  function view(file: ReviewFile): { patch: string; gaps: ContextGap[] } {
    const parsed = parse(file); if (!parsed) return { patch: file.patch, gaps: [] };
    const added = expansions(file), output = [...parsed.prefix], gaps: ContextGap[] = [];
    const insertGap = (id: number) => {
      const count = remaining(parsed.gaps[id], added.get(id) ?? empty());
      if (count !== 0) gaps.push({ id, index: output.length, remaining: count, above: id < parsed.hunks.length, below: id > 0 });
    };
    parsed.hunks.forEach((hunk, index) => {
      insertGap(index);
      const before = added.get(index)?.back ?? [], after = added.get(index + 1)?.front ?? [];
      const oldCount = hunk.oldCount + before.length + after.length, newCount = hunk.newCount + before.length + after.length;
      output.push(before.length || after.length ? `@@ -${hunk.old - before.length - (oldCount === 0 ? 1 : 0)},${oldCount} +${hunk.next - before.length - (newCount === 0 ? 1 : 0)},${newCount} @@${hunk.suffix}` : hunk.header,
        ...before.map(line => ` ${line}`), ...hunk.body, ...after.map(line => ` ${line}`));
      if (added.get(index + 1)?.noNewline) output.push("\\ No newline at end of file");
    });
    insertGap(parsed.hunks.length);
    return { patch: output.join("\n") + "\n", gaps };
  }
  async function expand(file: ReviewFile, target: ReviewRequest, id: number, direction: "above" | "below") {
    if (controller) return;
    const parsed = parse(file), gap = parsed?.gaps[id]; if (!parsed || !gap) return;
    const previous = expansions(file), added = previous.get(id) ?? empty(), left = remaining(gap, added);
    if (left === 0 || (direction === "above" ? id === parsed.hunks.length : id === 0)) return;
    const count = Math.min(20, left ?? 20);
    const offset = direction === "above" ? gap.total! - added.back.length - count : added.front.length;
    const request = { ...target, path: file.path, fingerprint: file.fingerprint, oldStart: gap.old + offset, newStart: gap.next + offset, count };
    const current = new AbortController(); controller = current; setBusy(true); setError("");
    try {
      const result = await load(request, current.signal);
      if (controller !== current) return;
      if (result.oldStart !== request.oldStart || result.newStart !== request.newStart || (left !== null && result.lines.length !== count) ||
          (result.noNewline && (gap.total !== null || direction !== "below"))) throw invalid();
      const size = [...previous.values()].reduce((sum, value) => sum + lineBytes(value.front) + lineBytes(value.back), 0) + lineBytes(result.lines);
      if (size > 256 * 1024) throw new Error("Expanded context reached its 256 KiB limit. Refresh to reset it.");
      const next = new Map(previous);
      next.set(id, direction === "above" ? { ...added, back: [...result.lines, ...added.back] } : { ...added, front: [...added.front, ...result.lines], end: !result.hasMore, noNewline: result.noNewline });
      setState({ key: key(file), expanded: next });
    } catch (reason) {
      if (controller === current) setError(reason instanceof Error ? reason.message : "Could not expand context. Refresh and retry.");
    } finally { if (controller === current) { controller = undefined; setBusy(false); } }
  }
  return { view, expand, reset, busy, error };
}
