import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { ReviewOverview } from "../src/ReviewOverview";
import type { ReviewEntry } from "../src/local-review";
import type { IntentGroup } from "../src/review-groups";

afterEach(cleanup);
const entry = (path: string): ReviewEntry => ({ path, status: "modified", previousPath: null, patch: null, fingerprint: null });

it("links risk and test hints to exact files without claiming tests passed", () => {
  const open = vi.fn();
  const page = render(() => <ReviewOverview files={[entry("src/auth.ts"), entry("migrations/002.sql"), entry("package.json"), { ...entry("test/auth.test.ts"), status: "deleted" }]} groups={undefined} reviewed={() => false} open={open} startGroup={() => {}} />);
  expect(page.getByRole("heading", { name: "Access and trust" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Stored data" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Dependencies and delivery" })).toBeTruthy();
  const tests = within(page.getByRole("region", { name: "Changed tests" }));
  expect(tests.getByText(/Tests are not run here/)).toBeTruthy();
  expect(tests.getByText(/Deleted tests may remove coverage/)).toBeTruthy();
  fireEvent.click(tests.getByRole("button", { name: "test/auth.test.ts" }));
  expect(open).toHaveBeenCalledExactlyOnceWith("test/auth.test.ts");
});

it("bounds path lists, reveals remaining files explicitly, and renders AI text as text", () => {
  const files = Array.from({ length: 10 }, (_, index) => entry(`src/file-${index}.ts`));
  const page = render(() => <ReviewOverview files={files} groups={[{ title: "<img src=x>", reason: "<script>bad()</script>", paths: files.map(file => file.path) }]} reviewed={() => false} open={() => {}} startGroup={() => {}} />);
  const steps = within(page.getByRole("list", { name: "Suggested review order" }));
  expect(steps.queryByRole("button", { name: "src/file-9.ts" })).toBeNull();
  expect(steps.getByRole("heading", { name: "<img src=x>" })).toBeTruthy();
  expect(page.container.querySelector("img,script")).toBeNull();
  fireEvent.click(steps.getByRole("button", { name: "Show all 10 files" })); flush();
  expect(steps.getByRole("button", { name: "src/file-9.ts" })).toBeTruthy();
});

it("expands all changed files through an accessible disclosure without opening a diff", () => {
  const open = vi.fn();
  const page = render(() => <ReviewOverview files={[entry("README.md")]} groups={undefined} reviewed={() => false} open={open} startGroup={() => {}} />);
  const trigger = page.getByRole("button", { name: "All 1 changed files" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(page.queryByRole("button", { name: "README.md" })).toBeNull();
  fireEvent.click(trigger); flush();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(page.getByRole("button", { name: "README.md" })).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
});

it("removes prior explanations and hints when the snapshot changes", () => {
  const [files, setFiles] = createSignal([entry("src/auth.ts")]);
  const [groups, setGroups] = createSignal<IntentGroup[] | undefined>([{ title: "Access", reason: "Earlier suggestion", paths: ["src/auth.ts"] }]);
  const page = render(() => <ReviewOverview files={files()} groups={groups()} reviewed={() => false} open={() => {}} startGroup={() => {}} />);
  expect(page.getByText("Earlier suggestion")).toBeTruthy();
  setGroups(undefined); setFiles([entry("README.md")]); flush();
  expect(page.queryByText("Earlier suggestion")).toBeNull();
  expect(page.queryByRole("heading", { name: "Access and trust" })).toBeNull();
  expect(page.getByText(/No changed test files recognized/)).toBeTruthy();
});
