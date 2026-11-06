import { createSignal } from "solid-js";
import { diffLines, type DiffLine, type ReviewEntry, type ReviewFile, type ReviewRequest } from "./local-review";
import { accountResponse, emptyUsage, noisyFile, type GroupModel, type GroupOptions, type GroupUsage } from "./review-costs";
import type { GroupLoader, GroupRequest, IntentGroup } from "./review-groups";

/** Coordinates are inclusive, 1-based raw unified-diff rows, not source-file lines. */
export interface EvidenceCitation { path: string; startLine: number; endLine: number }
export interface ExplanationStatement { text: string; citations: EvidenceCitation[] }
export interface ReviewExplanation { observations: ExplanationStatement[]; inferences: ExplanationStatement[]; risks: ExplanationStatement[]; limitations: string[] }
export interface ExplanationSource { files: ReviewEntry[]; target: ReviewRequest; options: GroupOptions; model?: GroupModel; snapshotKey?: string }
export interface ExplanationEvidence { fingerprint: string; rows: DiffLine[] }
export interface ExplanationResult { value: ReviewExplanation; evidence: Map<string, ExplanationEvidence>; usage: GroupUsage; supplied: number; total: number; sampled: boolean }
const encoder = new TextEncoder();
const size = (text: string) => encoder.encode(text).length;
const object = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => key in value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && [...value].length <= max;

/** Checks evidence membership, not the truth of the model's interpretation. */
export function validateExplanation(value: unknown, request: GroupRequest): ReviewExplanation {
  const invalid = () => new Error("Invalid AI explanation or citation outside supplied evidence.");
  if (!object(value, ["explanation"]) || !object(value.explanation, ["observations", "inferences", "risks", "limitations"])) throw invalid();
  const result = value.explanation;
  let total = 0;
  for (const kind of ["observations", "inferences", "risks"] as const) {
    const statements = result[kind];
    if (!Array.isArray(statements) || statements.length > 8 || (kind === "observations" && !statements.length)) throw invalid();
    total += statements.length;
    for (const statement of statements) {
      if (!object(statement, ["text", "citations"]) || !text(statement.text, 600) || !Array.isArray(statement.citations) || !statement.citations.length || statement.citations.length > 4) throw invalid();
      const seen = new Set<string>();
      for (const citation of statement.citations) {
        if (!object(citation, ["path", "startLine", "endLine"]) || typeof citation.path !== "string" || !Number.isSafeInteger(citation.startLine) || !Number.isSafeInteger(citation.endLine)) throw invalid();
        const start = citation.startLine as number, end = citation.endLine as number;
        if (start < 1 || end < start || end - start >= 20 || !request.details.some(detail => detail.path === citation.path && start >= detail.startLine && end < detail.startLine + detail.patch.replace(/\n$/, "").split("\n").length)) throw invalid();
        const key = JSON.stringify(citation);
        if (seen.has(key)) throw invalid();
        seen.add(key);
      }
    }
  }
  if (total > 20 || !Array.isArray(result.limitations) || result.limitations.length > 8 || result.limitations.some(item => !text(item, 300))) throw invalid();
  return result as unknown as ReviewExplanation;
}

/** Unavailable local-review notices are display text, never diff evidence. */
export function readableReviewPatch(patch: string): boolean {
  return !["Untracked content omitted; file has not been read.\n", "Binary content omitted.\n", "Non-UTF-8 patch omitted.\n", "Patch exceeds 64 KiB; content omitted.\n"].includes(patch);
}
const groupKey = (group: IntentGroup) => JSON.stringify([group.title, group.paths]);
const sourceKey = (source: ExplanationSource) => JSON.stringify([source.target, source.snapshotKey, source.model, source.options.includeGenerated]);

/** One explicit, bounded inference per group. Exact evidence/model keyed results stay in memory
 * (four entries); refresh cancels visible work but retains reusable results. No chat or review marks change.
 */
export function createReviewExplanations(
  load: GroupLoader,
  read: (path: string, target: ReviewRequest, signal: AbortSignal) => Promise<ReviewFile>,
  source: () => ExplanationSource | undefined,
  verify?: (source: ExplanationSource, signal: AbortSignal) => Promise<boolean>,
) {
  const [results, setResults] = createSignal(new Map<string, { source: string; result: ExplanationResult }>());
  const [busy, setBusy] = createSignal(""), [error, setError] = createSignal("");
  const cache = new Map<string, ExplanationResult>();
  let controller: AbortController | undefined;
  function cancel() { controller?.abort(); controller = undefined; setBusy(""); }
  function invalidate() { cancel(); setResults(new Map()); setError(""); }
  function result(group: IntentGroup) {
    const current = source(), entry = results().get(groupKey(group));
    if (!entry || !current || entry.source !== sourceKey(current)) return;
    if ([...entry.result.evidence].some(([path, evidence]) => { const file = current.files.find(file => file.path === path); return !file || (file.fingerprint !== null && file.fingerprint !== evidence.fingerprint); })) return;
    return entry.result;
  }
  async function explain(group: IntentGroup) {
    cancel(); setError("");
    const captured = source();
    if (!captured) return;
    const current = new AbortController(); controller = current; setBusy(groupKey(group));
    const timeout = setTimeout(() => current.abort(), 90000);
    const active = () => controller === current && !current.signal.aborted && source() !== undefined && sourceKey(source()!) === sourceKey(captured);
    try {
      if (!group.paths.length || group.paths.length > 1000 || new Set(group.paths).size !== group.paths.length) throw new Error("Explain a group of at most 1,000 files.");
      const files = new Map(captured.files.map(file => [file.path, file]));
      if (group.paths.some(path => !files.has(path))) throw new Error("This group is stale. Refresh groups before explaining it.");
      if (verify && !await verify(captured, current.signal)) throw new Error("Changes moved. Refresh before explaining.");
      if (!active()) return;
      const request: GroupRequest = { files: group.paths.map(path => ({ path, status: files.get(path)!.status, patch: null, added: 0, removed: 0, patchLines: 0, sampled: true })), details: [], readsRemaining: 0, model: captured.model, explain: { title: group.title } };
      const evidence = new Map<string, ExplanationEvidence>();
      let sampled = false;
      // Up to eight eligible files; each excerpt keeps complete lines within 6 KiB/120 rows.
      for (const path of group.paths.filter(path => captured.options.includeGenerated || !noisyFile(path)).slice(0, 8)) {
        const file = await read(path, captured.target, current.signal);
        if (!active()) return;
        if (file.path !== path || file.patch === null || !file.fingerprint) throw new Error("Invalid explanation evidence.");
        if (!readableReviewPatch(file.patch)) continue;
        const rows = diffLines(file.patch), lines: string[] = [];
        let bytes = 0;
        for (const row of rows.slice(0, 120)) {
          const next = size(row.text) + (lines.length ? 1 : 0);
          if (bytes + next > 6144) break;
          bytes += next; lines.push(row.text);
        }
        if (!lines.length || !lines.join("\n")) continue;
        sampled ||= lines.length < rows.length;
        const entry = request.files.find(file => file.path === path)!;
        entry.patch = ""; entry.patchLines = rows.length;
        request.details.push({ path, startLine: 1, patch: lines.join("\n") });
        evidence.set(path, { fingerprint: file.fingerprint, rows: rows.slice(0, lines.length) });
      }
      if (!request.details.length) throw new Error("No readable diff evidence in this group. Generated contents may be excluded in Settings.");
      const body = JSON.stringify(request);
      if (size(body) > Math.min(192 * 1024, captured.options.maxRequestBytes) || captured.options.maxCalls < 1) throw new Error("Explanation exceeds the configured AI request budget. Raise it in Settings or choose a smaller group.");
      // Fingerprints include uncited changes; evidence bytes prevent filename-only cache reuse.
      const key = JSON.stringify(["explain-v1", captured.target, captured.snapshotKey, body, [...evidence].map(([path, item]) => [path, item.fingerprint])]);
      let answer = cache.get(key);
      if (answer) answer = { ...answer, usage: { ...emptyUsage(), reused: true } };
      else {
        const response = await load(request, current.signal);
        if (!active()) return;
        const accounted = accountResponse(response, { ...emptyUsage(), calls: 1, requestBytes: size(body) });
        answer = { value: validateExplanation(accounted.result, request), evidence, usage: accounted.usage, supplied: evidence.size, total: group.paths.length, sampled };
      }
      if (verify && !await verify(captured, current.signal)) throw new Error("Changes moved during explanation. Refresh and try again.");
      if (!active()) return;
      cache.delete(key); cache.set(key, answer);
      while (cache.size > 4) cache.delete(cache.keys().next().value!);
      setResults(previous => {
        const next = new Map(previous);
        next.delete(groupKey(group)); next.set(groupKey(group), { source: sourceKey(captured), result: answer! });
        while (next.size > 4) next.delete(next.keys().next().value!);
        return next;
      });
    } catch (reason) {
      if (controller === current) setError(current.signal.aborted ? "Explanation cancelled or timed out." : reason instanceof Error ? reason.message : "Could not explain this group.");
    } finally { clearTimeout(timeout); if (controller === current) { controller = undefined; setBusy(""); } }
  }
  return { result, explain, busy, error, cancel, invalidate, key: groupKey };
}
export type ReviewExplanations = ReturnType<typeof createReviewExplanations>;
