import { expect, it } from "vitest";
import { matchAuthorNotes, parseAuthorNotes } from "../src/author-notes";

const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n";
const file = { path: "a.ts", previousPath: null, status: "modified", patch, fingerprint: "live", checkoutKey: "a".repeat(64) };
const input = () => ({ notes: [{ path: "a.ts", side: "new", line: 2, quote: "new", text: "Keep retries.", binding: { recordedBy: "tool-v1", checkoutKey: file.checkoutKey, base: "b".repeat(40), head: "c".repeat(40), fingerprint: "d".repeat(64), patch } }] });

it("requires server evidence for automatic notes but preserves explicit legacy imports", () => {
  const value = { notes: [{ path: "a.ts", side: "new", line: 2, quote: "new", text: "Keep retries." }] };
  expect(() => parseAuthorNotes(value, true)).toThrow(/provenance/);
  expect(matchAuthorNotes(parseAuthorNotes(value), file).matched).toHaveLength(1);
});
it("never reattaches a note flagged outdated at completion even if code is later restored", () => {
  const value = input();
  const notes = parseAuthorNotes({ notes: value.notes.map(note => ({ ...note, binding: { ...note.binding, outdated: true } })) }, true);
  expect(matchAuthorNotes(notes, file).matched).toHaveLength(0);
});
it("rejects a different checkout even when the line and quote are identical", () => {
  const result = matchAuthorNotes(parseAuthorNotes(input()), { ...file, checkoutKey: "f".repeat(64) });
  expect(result.matched).toHaveLength(0);
  expect(result.stale).toHaveLength(1);
});
it("rejects changed hunk context even when the selected line is untouched", () => {
  expect(matchAuthorNotes(parseAuthorNotes(input()), { ...file, patch: patch.replace(" context", " changed") }).matched).toHaveLength(0);
});
it("keeps function context and rejects an ambiguous original hunk", () => {
  const value = input();
  value.notes[0].binding.patch = patch.replace("@@ -1,2 +1,2 @@", "@@ -1,2 +1,2 @@ function first()");
  expect(matchAuthorNotes(parseAuthorNotes(value), { ...file, patch: patch.replace("@@ -1,2 +1,2 @@", "@@ -1,2 +1,2 @@ function other()") }).matched).toHaveLength(0);
  value.notes[0].binding.patch = patch + "@@ -40,2 +50,2 @@\n context\n-old\n+new\n";
  expect(matchAuthorNotes(parseAuthorNotes(value), file).matched).toHaveLength(0);
});
it("relocates only a uniquely unchanged whole hunk", () => {
  const shifted = patch.replace("@@ -1,2 +1,2 @@", "@@ -11,2 +21,2 @@");
  expect(matchAuthorNotes(parseAuthorNotes(input()), { ...file, patch: shifted }).matched).toHaveLength(1);
  expect(matchAuthorNotes(parseAuthorNotes(input()), { ...file, patch: shifted + "@@ -40,2 +50,2 @@\n context\n-old\n+new\n" }).matched).toHaveLength(0);
});
