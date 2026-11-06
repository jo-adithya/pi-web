import { flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { diffLines, type ReviewEntry } from "../src/local-review";
import { createReviewHistory, reviewLineKey } from "../src/review-history";

function file(fingerprint: string | null = "one", patch: string | null = "@@ -1 +1 @@\n-old\n+new\n", path = "a.ts"): ReviewEntry {
  return { path, previousPath: null, status: "modified", fingerprint, patch };
}

describe("review history", () => {
  it("retains a manual fingerprint until uncheck or reset", () => {
    const history = createReviewHistory();
    expect(history.status(file())).toBe("unreviewed");
    history.mark(file(), true); flush();
    expect(history.isReviewed(file())).toBe(true);
    expect(history.status(file())).toBe("reviewed");
    expect(history.reviewedFingerprint("a.ts")).toBe("one");
  });
  it("keeps marks through changed and missing fingerprints, and clears explicitly", () => {
    const history = createReviewHistory();
    history.mark(file(), true); flush();
    expect(history.status(file("two"))).toBe("changed");
    expect(history.status(file(null, null))).toBe("pending");
    history.mark(file(null, null), true); flush();
    expect(history.reviewedFingerprint("a.ts")).toBe("one");
    history.mark(file(null, null), false); flush();
    expect(history.status(file())).toBe("unreviewed");
    expect(history.hasBaseline(file())).toBe(false);
    history.mark(file(), true); flush();
    history.reset(); flush();
    expect(history.reviewedFingerprint("a.ts")).toBeUndefined();
    expect(history.comparison(file("two"))).toBeUndefined();
    history.mark(file(null, null), true); flush();
    expect(history.status(file(null, null))).toBe("unreviewed");
  });

  it("compares only the middle and uses current coordinates for highlighting", () => {
    const history = createReviewHistory();
    const before = file("one", "@@ -1,3 +1,3 @@\n edge\n-old\n+before\n tail\n");
    const after = file("two", "@@ -10,3 +20,3 @@\n edge\n-old\n+after\n tail\n");
    history.mark(before, true); flush();
    const result = history.comparison(after)!;
    expect([...result.changed]).toEqual([reviewLineKey(diffLines(after.patch!)[3])]);
    expect(result.previous).toEqual(["+before"]);
    expect(result.limited).toBe(false);
    result.changed.clear(); result.previous.push("corruption");
    before.patch = "mutated";
    expect(history.comparison(after)?.previous).toEqual(["+before"]);
    expect(history.comparison(after)?.changed.size).toBe(1);
    expect(history.reviewedFingerprint(after.path)).toBe("one");
  });

  it("reports metadata-only changes without highlighting stable shifted rows", () => {
    const history = createReviewHistory();
    history.mark(file(), true); flush();
    expect(history.comparison(file())).toBeUndefined();
    const comparison = history.comparison(file("two", "@@ -8 +12 @@\n-old\n+new\n"))!;
    expect(comparison.changed.size).toBe(0);
    expect(comparison.previous).toEqual([]);
    expect(history.comparison(file(null, null))).toBeUndefined();
  });

  it("conservatively includes duplicate and matching interior rows", () => {
    const history = createReviewHistory();
    history.mark(file("one", "@@ -1 +1,5 @@\n+edge\n+a\n+repeat\n+b\n+edge\n"), true); flush();
    const current = file("two", "@@ -1 +1,5 @@\n+edge\n+x\n+repeat\n+y\n+edge\n");
    expect(history.comparison(current)?.changed).toEqual(new Set(diffLines(current.patch!).slice(2, 5).map(reviewLineKey)));
    expect(history.comparison(current)?.previous).toEqual(["+a", "+repeat", "+b"]);
    expect(reviewLineKey({ kind: "add", text: "+same", next: 1 })).not.toBe(reviewLineKey({ kind: "add", text: "+same", next: 2 }));
  });

  it("caps previous rows at 200 including pure removals", () => {
    const history = createReviewHistory();
    history.mark(file("one", "@@ -1 +1,201 @@\n" + "+old\n".repeat(201)), true); flush();
    const result = history.comparison(file("two", ""))!;
    expect(result.previous).toHaveLength(200);
    expect(result.changed.size).toBe(0);
    expect(result.limited).toBe(true);
  });

  it("handles insertions and the exact previous-row limit, and captures only on mark", () => {
    const history = createReviewHistory();
    const original = file("one", "@@ -1 +1 @@\n+edge\n");
    history.mark(original, true);
    original.fingerprint = "mutated"; original.patch = "mutated"; flush();
    expect(history.reviewedFingerprint("a.ts")).toBe("one");
    const added = file("two", "@@ -1 +1,2 @@\n+edge\n+inserted\n");
    expect(history.comparison(added)?.previous).toEqual([]);
    expect(history.comparison(added)?.changed).toEqual(new Set([reviewLineKey(diffLines(added.patch!)[2])]));
    expect(history.reviewedFingerprint("a.ts")).toBe("one");
    history.mark(added, true); flush();
    expect(history.comparison(file("three", "@@ -1 +1 @@\n+edge\n"))?.previous).toEqual(["+inserted"]);
    history.mark(file("four", "@@ -1 +1,200 @@\n" + "+old\n".repeat(200)), true); flush();
    const result = history.comparison(file("five", ""))!;
    expect(result.previous).toHaveLength(200);
    expect(result.limited).toBe(false);
  });

  it("evicts the least recently compared baseline after 64 patches without losing marks", () => {
    const history = createReviewHistory();
    for (let i = 0; i < 64; i++) history.mark(file("one", "+a", `${i}`), true);
    flush();
    history.comparison(file("two", "+b", "0"));
    history.mark(file("one", "+a", "64"), true); flush();
    expect(history.hasBaseline(file("one", "+a", "0"))).toBe(true);
    expect(history.hasBaseline(file("one", "+a", "1"))).toBe(false);
    expect(history.status(file("two", "+a", "1"))).toBe("changed");
    expect(history.reviewedFingerprint("1")).toBe("one");
    expect(history.comparison(file("two", "+a", "1"))).toBeUndefined();
  });

  it("budgets UTF-8 patch bytes at 1 MiB and replaces old snapshots only on manual mark", () => {
    const history = createReviewHistory();
    const half = "é".repeat(262144);
    history.mark(file("one", half, "a"), true);
    history.mark(file("one", half, "b"), true); flush();
    expect(history.hasBaseline(file("one", half, "a"))).toBe(true);
    history.mark(file("one", "x", "c"), true); flush();
    expect(history.hasBaseline(file("one", half, "a"))).toBe(false);
    expect(history.hasBaseline(file("one", half, "b"))).toBe(true);
    history.mark(file("two", "small", "b"), true); flush();
    expect(history.reviewedFingerprint("b")).toBe("two");
    history.mark(file("one", "x".repeat(1048577), "large"), true); flush();
    expect(history.hasBaseline(file("one", null, "large"))).toBe(false);
    expect(history.status(file("one", null, "large"))).toBe("reviewed");
    expect(history.hasBaseline(file("two", "small", "b"))).toBe(true);
  });
});
