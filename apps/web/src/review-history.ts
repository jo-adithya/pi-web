import { createSignal } from "solid-js";
import { diffLines, hasPatch, type DiffLine, type ReviewEntry } from "./local-review";

/** Identifies a rendered row by both source coordinates and its displayed content. */
export function reviewLineKey(line: DiffLine): string {
  return JSON.stringify([line.old, line.next, line.kind, line.text]);
}

interface Baseline { patch: string; bytes: number }
export interface ReviewComparison {
  changed: Set<string>;
  /** Replaced or removed baseline rows, with their original diff prefixes. */
  previous: string[];
  limited: boolean;
}

/**
 * Owns reactive manual marks for one scope; call reset when that scope changes.
 * Baselines retain at most 64 patches and 1 MiB of UTF-8 patch text in memory.
 * Marking and comparing refresh LRU recency; eviction preserves reviewed fingerprints.
 */
export function createReviewHistory() {
  const [reviewed, setReviewed] = createSignal(new Map<string, string>());
  const baselines = new Map<string, Baseline>();
  let bytes = 0;
  const reviewedFingerprint = (path: string) => reviewed().get(path);
  const isReviewed = (file: ReviewEntry) => file.fingerprint !== null && reviewedFingerprint(file.path) === file.fingerprint;

  function status(file: ReviewEntry): "unreviewed" | "pending" | "reviewed" | "changed" {
    const fingerprint = reviewedFingerprint(file.path);
    if (fingerprint === undefined) return "unreviewed";
    if (file.fingerprint === null) return "pending";
    return fingerprint === file.fingerprint ? "reviewed" : "changed";
  }

  function removeBaseline(path: string) {
    const baseline = baselines.get(path);
    if (baseline) bytes -= baseline.bytes;
    baselines.delete(path);
  }

  /** Captures loaded content on manual check; uncheck also works for unloaded entries. */
  function mark(file: ReviewEntry, checked: boolean) {
    if (checked && !hasPatch(file)) return;
    removeBaseline(file.path);
    if (checked && hasPatch(file)) {
      const size = new TextEncoder().encode(file.patch).length;
      if (size <= 1024 * 1024) {
        baselines.set(file.path, { patch: file.patch, bytes: size });
        bytes += size;
        for (const path of baselines.keys()) {
          if (bytes <= 1024 * 1024 && baselines.size <= 64) break;
          removeBaseline(path);
        }
      }
    }
    const { path, fingerprint } = file;
    setReviewed(previous => {
      const next = new Map(previous);
      if (checked && fingerprint !== null) next.set(path, fingerprint);
      else next.delete(path);
      return next;
    });
  }

  /** Reports retained baseline availability without changing LRU recency. */
  function hasBaseline(file: ReviewEntry): boolean {
    return reviewedFingerprint(file.path) !== undefined && baselines.has(file.path);
  }

  /**
   * Compares changed, loaded patches against the last manual mark. Exact kind/text
   * prefix and suffix rows stay unhighlighted regardless of coordinate shifts.
   * The entire current middle is highlighted; previous middle text is capped at
   * 200 rows. Results are fresh copies. Missing or evicted baselines return undefined.
   */
  function comparison(file: ReviewEntry): ReviewComparison | undefined {
    if (status(file) !== "changed" || !hasPatch(file)) return undefined;
    const baseline = baselines.get(file.path);
    if (!baseline) return undefined;
    baselines.delete(file.path); baselines.set(file.path, baseline);
    const before = diffLines(baseline.patch).filter(line => line.kind !== "header");
    const current = diffLines(file.patch).filter(line => line.kind !== "header");
    const same = (a: DiffLine, b: DiffLine) => a.kind === b.kind && a.text === b.text;
    let start = 0, oldEnd = before.length, newEnd = current.length;
    while (start < oldEnd && start < newEnd && same(before[start], current[start])) start++;
    while (oldEnd > start && newEnd > start && same(before[oldEnd - 1], current[newEnd - 1])) { oldEnd--; newEnd--; }
    const previous = before.slice(start, Math.min(oldEnd, start + 200)).map(line => line.text);
    return {
      changed: new Set(current.slice(start, newEnd).map(reviewLineKey)),
      previous,
      limited: oldEnd - start > 200,
    };
  }

  /** Clears all marks and baseline content at a scope boundary. */
  function reset() {
    baselines.clear(); bytes = 0;
    setReviewed(new Map());
  }

  return { mark, isReviewed, status, comparison, reset, reviewedFingerprint, hasBaseline };
}
