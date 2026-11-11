import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { Markdown } from "../src/components/Markdown";
afterEach(cleanup);
it("opens workspace references from inline code and Markdown links without navigating", () => {
  const open = vi.fn();
  const page = render(() => <Markdown complete text={'See `src/main.ts:42` and [the handler](apps/server/src/http.rs#L150-L155).'} openCode={open} />);
  fireEvent.click(page.getByRole("link", { name: "src/main.ts:42" }));
  expect(open).toHaveBeenLastCalledWith({ path: "src/main.ts", line: 42, endLine: 42 });
  fireEvent.click(page.getByRole("link", { name: "the handler" }));
  expect(open).toHaveBeenLastCalledWith({ path: "apps/server/src/http.rs", line: 150, endLine: 155 });
});
it("supports file-only references and never nests source links inside external links", () => {
  const open = vi.fn();
  const page = render(() => <Markdown complete text={'See [the file](src/main.ts) and [`src/other.ts:2`](https://example.com).'} openCode={open} />);
  fireEvent.click(page.getByRole("link", { name: "the file" }));
  expect(open).toHaveBeenCalledWith({ path: "src/main.ts", line: 1, endLine: 1 });
  expect(page.getAllByRole("link")).toHaveLength(2);
  expect(page.getByRole("link", { name: "src/other.ts:2" }).getAttribute("href")).toBe("https://example.com");
});
it("keeps traversal, absolute, executable, and fenced references inert", () => {
  const open = vi.fn();
  const page = render(() => <Markdown complete text={'`../secret:1` `/etc/passwd:1` `javascript:alert(1)`\n\n```ts\nsrc/main.ts:42\n```\n\n[bad](file:///etc/passwd#L1)'} openCode={open} />);
  expect(page.queryAllByRole("link")).toHaveLength(0);
  expect(open).not.toHaveBeenCalled();
});
