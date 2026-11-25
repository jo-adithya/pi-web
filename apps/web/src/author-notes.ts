import { diffLines, type ReviewFile } from "./local-review";
export { default as authorNoteInstructions } from "../../shared/author-notes.txt?raw";

export interface AuthorBinding { recordedBy?: "tool-v1"; outdated?: boolean; checkoutKey: string; base: string; head: string; fingerprint: string; patch: string }
export interface AuthorNote { path: string; side: "new" | "old"; line: number; quote: string; text: string; chapter?: string; binding?: AuthorBinding }
/** Validates the bounded agent-produced file before matching any notes to source. */
export function parseAuthorNotes(value: unknown, requireBinding = false): AuthorNote[] {
  const input = value as { notes?: unknown } | null;
  if (!input || !Array.isArray(input.notes) || input.notes.length > 64) throw new Error("Expected at most 64 author notes.");
  return input.notes.map((item: unknown) => {
    const note = item as AuthorNote | null;
    if (!note || typeof note.path !== "string" || !note.path || (note.side !== "new" && note.side !== "old") || !Number.isSafeInteger(note.line) || note.line < 1 || typeof note.quote !== "string" || !note.quote || typeof note.text !== "string" || !note.text.trim() || note.text.length > 4000 || (note.chapter !== undefined && (typeof note.chapter !== "string" || note.chapter.length > 80))) throw new Error("Invalid author note. Include path, side, line, exact quote, and short text.");
    const binding = note.binding;
    if ((requireBinding && binding?.recordedBy !== "tool-v1") || (binding && ((binding.recordedBy !== undefined && binding.recordedBy !== "tool-v1") || (binding.outdated !== undefined && typeof binding.outdated !== "boolean") || typeof binding.patch !== "string" || new TextEncoder().encode(binding.patch).length > 65536 || !/^[a-f0-9]{64}$/.test(binding.checkoutKey) || !/^[a-f0-9]{64}$/.test(binding.fingerprint) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.base) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.head)))) throw new Error("Author-note provenance is unavailable or invalid. Generate fresh notes in this checkout.");
    return { ...note, text: note.text.trim() };
  });
}

/** Relocates an original raw diff row only within one identical hunk, ignoring hunk-header line offsets. */
export function relocateAuthorRow(originalPatch: string, row: number, nextPatch: string): number | undefined {
  const original = diffLines(originalPatch), next = diffLines(nextPatch);
  const hunks = (lines: ReturnType<typeof diffLines>) => lines.flatMap((line, index) => line.text.startsWith("@@ ") ? [index + 1] : []).map((start, index, starts) => ({
    start,
    context: lines[start - 1].text.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@"),
    body: lines.slice(start, index + 1 < starts.length ? starts[index + 1] - 1 : lines.length).map(line => line.text),
  }));
  const originals = hunks(original);
  const source = originals.find(hunk => row >= hunk.start && row < hunk.start + hunk.body.length);
  const same = (hunk: typeof originals[number]) => source && hunk.context === source.context && JSON.stringify(hunk.body) === JSON.stringify(source.body);
  if (originals.filter(same).length !== 1) return;
  const candidates = hunks(next).filter(same);
  return source && candidates.length === 1 ? candidates[0].start + row - source.start : undefined;
}

/** Bound notes require the same checkout and a uniquely unchanged whole hunk. Manual legacy notes use exact coordinates. */
export function matchAuthorNotes(notes: AuthorNote[], file: ReviewFile) {
  const rows = diffLines(file.patch);
  const matched: { note: AuthorNote; row: number }[] = [], stale: AuthorNote[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    if (note.path !== file.path) continue;
    const key = JSON.stringify([note.side, note.line, note.quote, note.text, note.chapter]);
    if (seen.has(key)) continue;
    seen.add(key);
    const original = note.binding ? diffLines(note.binding.patch) : rows;
    const indices = original.flatMap((row, index) => row.kind !== "header" && (note.side === "new" ? row.next : row.old) === note.line && row.text.slice(1) === note.quote ? [index] : []);
    if (note.binding?.outdated || indices.length !== 1 || (note.binding && note.binding.checkoutKey !== file.checkoutKey)) { stale.push(note); continue; }
    if (!note.binding) { matched.push({ note, row: indices[0] + 1 }); continue; }
    const relocated = relocateAuthorRow(note.binding.patch, indices[0], file.patch);
    if (relocated !== undefined) matched.push({ note, row: relocated + 1 }); else stale.push(note);
  }
  return { matched, stale };
}
