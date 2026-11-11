import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import type { DisplayMessage, ResponseCard } from "../src/generated/protocol";
import { SimpleResponse } from "../src/components/SimpleResponse";

afterEach(cleanup);
function renderCard(card: ResponseCard) {
  const message: DisplayMessage = { id: "reply", role: "assistant", complete: true, truncated: false, error: null, blocks: [],
    presentation: { state: "ready", response: { summary: "Update ready.", blocks: [card] } } };
  const view = render(() => <SimpleResponse message={message} original={() => <p>Original answer</p>} />);
  flush(); return view;
}

const timings = { model: "openai-codex/gpt-6-luna", cached: false, workMs: 59850, totalMs: 3600, queueMs: 20, startupMs: 18, modelMs: 3560, firstTextMs: 1500, cleanupMs: 2 };

it("exposes measured formatter stages on hover, keyboard focus and tap", async () => {
  const message: DisplayMessage = { id: "timed", role: "assistant", complete: true, truncated: false, error: null, blocks: [],
    presentation: { state: "ready", response: { summary: "Done.", blocks: [] }, ...{ timings } } };
  const view = render(() => <SimpleResponse message={message} original={() => <p>Original answer</p>} />); flush();
  const trigger = view.getByRole("button", { name: "About response timing" });
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" }); flush();
  const tooltip = await screen.findByRole("tooltip");
  const table = within(tooltip).getByRole("table", { name: "Response timing" });
  for (const row of ["Pi’s work 1 m 0 s", "Total processing 1 m 3 s", "Queue wait 20 ms", "Formatter startup 18 ms", "Model request 4 s", "Wait for first text 2 s", "Remaining output 2 s", "Cleanup 2 ms", "Total formatting 4 s"]) {
    expect(within(table).getByRole("row", { name: row })).toBeTruthy();
  }
  expect(tooltip.textContent).toContain("openai-codex/gpt-6-luna");
  expect(tooltip.textContent).toContain("Saving and browser delivery are not measured.");
  expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
  fireEvent.pointerLeave(trigger, { pointerType: "mouse" }); flush();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  trigger.focus(); flush(); await screen.findByRole("tooltip");
  fireEvent.keyDown(trigger, { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  fireEvent.click(trigger); flush(); await screen.findByRole("tooltip");
  fireEvent.click(trigger); flush();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  expect(view.queryByText("Original answer")).toBeNull();
});

it("labels cached timing as historical and leaves older answers without invented measurements", async () => {
  const message: DisplayMessage = { id: "cached", role: "assistant", complete: true, truncated: false, error: null, blocks: [],
    presentation: { state: "ready", response: { summary: "Saved.", blocks: [] }, ...{ timings: { ...timings, cached: true } } } };
  const view = render(() => <SimpleResponse message={message} original={() => <p>Original</p>} />); flush();
  fireEvent.click(view.getByRole("button", { name: "About response timing" })); flush();
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("Timings are from the original run.");
  expect(within(tooltip).getByRole("row", { name: "Original Pi work 1 m 0 s" })).toBeTruthy();
  expect(within(tooltip).getByRole("row", { name: "Original formatting 4 s" })).toBeTruthy();
  expect(within(tooltip).getByRole("row", { name: "Original total processing 1 m 3 s" })).toBeTruthy();
  cleanup();
  renderCard({ type: "note", title: "Next", text: "Review it." });
  fireEvent.click(screen.getByRole("button", { name: "About response timing" })); flush();
  expect((await screen.findByRole("tooltip")).textContent).toContain("Timing wasn’t recorded for this reply.");
  expect(screen.queryByRole("table")).toBeNull();
});

it("includes a measured zero-length Pi run in the total", async () => {
  const message: DisplayMessage = { id: "instant", role: "assistant", complete: true, truncated: false, error: null, blocks: [],
    presentation: { state: "ready", response: { summary: "Done.", blocks: [] }, timings: { ...timings, workMs: 0 } } };
  const view = render(() => <SimpleResponse message={message} original={() => <p>Original</p>} />); flush();
  fireEvent.click(view.getByRole("button", { name: "About response timing" })); flush();
  const tooltip = await screen.findByRole("tooltip");
  expect(within(tooltip).getByRole("row", { name: "Pi’s work 0 ms" })).toBeTruthy();
  expect(within(tooltip).getByRole("row", { name: "Total processing 4 s" })).toBeTruthy();
});

it("does not invent Pi work or a total for older formatter-only timings", async () => {
  const { workMs, ...olderTimings } = timings;
  const message: DisplayMessage = { id: "older", role: "assistant", complete: true, truncated: false, error: null, blocks: [],
    presentation: { state: "ready", response: { summary: "Saved.", blocks: [] }, timings: olderTimings } };
  const view = render(() => <SimpleResponse message={message} original={() => <p>Original</p>} />); flush();
  fireEvent.click(view.getByRole("button", { name: "About response timing" })); flush();
  const tooltip = await screen.findByRole("tooltip");
  expect(within(tooltip).getByRole("row", { name: "Pi’s work Not recorded" })).toBeTruthy();
  expect(within(tooltip).getByRole("row", { name: "Total processing Not recorded" })).toBeTruthy();
  expect(within(tooltip).getByRole("row", { name: "Total formatting 4 s" })).toBeTruthy();
});

it("shows timing for failed attempts without inventing a first-text measurement", async () => {
  const message: DisplayMessage = { id: "failed", role: "assistant", complete: true, truncated: false, error: null, blocks: [],
    presentation: { state: "error", message: "Simplifying timed out.", retryable: true, timings: { ...timings, totalMs: 60030, queueMs: 10, modelMs: 60000, firstTextMs: null } } };
  const view = render(() => <SimpleResponse message={message} original={() => <p>Original</p>} />); flush();
  fireEvent.click(view.getByRole("button", { name: "About response timing" })); flush();
  const tooltip = await screen.findByRole("tooltip");
  expect(within(tooltip).getByRole("row", { name: "Model request 1 m 0 s" })).toBeTruthy();
  expect(within(tooltip).getByRole("row", { name: "Total processing 2 m 0 s" })).toBeTruthy();
  expect(within(tooltip).queryByRole("row", { name: /Wait for first text/ })).toBeNull();
  expect(view.getByRole("alert").textContent).toContain("Simplifying timed out.");
});

it("renders literal, highlighted code without interpreting fences or executable HTML", () => {
  const code = '  const sample = "<script>bad()</script>";\r\n  const fence = "```";\n';
  const view = renderCard({ type: "code", title: "Source example", language: "typescript", code });
  expect(view.getByRole("heading", { name: "Source example" })).toBeTruthy();
  expect(view.getByText("typescript")).toBeTruthy();
  expect(view.container.querySelector("pre > code")?.textContent).toBe(code);
  expect(view.container.querySelector(".hljs-keyword")?.textContent).toBe("const");
  expect(view.getByRole("button", { name: "Copy code" })).toBeTruthy();
  expect(view.container.querySelector("script, iframe, img")).toBeNull();
});

it.each(["html", "html preview", "__proto__", undefined])("keeps markup literal with language %s", language => {
  const code = '<script>bad()</script>\n<img src="https://example.invalid/tracker">\n```html preview\n<svg onload="bad()"></svg>\n```';
  const view = renderCard({ type: "code", title: "Literal markup", language, code });
  expect(view.container.querySelector("pre > code")?.textContent).toBe(code);
  expect(view.getByRole("region", { name: "Code snippet: Literal markup" }).querySelector("script, iframe, img, svg, style")).toBeNull();
});

it("keeps large snippets complete and unknown languages safely readable", () => {
  const code = "example line\n".repeat(6000) + "END OF SOURCE";
  const view = renderCard({ type: "code", title: "Complete source", language: "html preview", code });
  expect(view.container.querySelector("pre > code")?.textContent).toBe(code);
  expect(view.container.querySelector("iframe, .hljs-keyword")).toBeNull();
});

it("keeps comparison data in a labelled table with safe Markdown cells", () => {
  const view = renderCard({ type: "table", title: "Model comparison", columns: ["Model", "Delay"], rows: [["**Luna**", "3.6 s"], ["Other", "<script>bad()</script>"]] });
  const table = view.getByRole("table", { name: "Model comparison" });
  expect(within(table).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["Model", "Delay"]);
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  expect(within(table).getByRole("cell", { name: "Luna" }).querySelector("strong")).not.toBeNull();
  expect(within(table).getByRole("cell", { name: "3.6 s" })).toBeTruthy();
  expect(table.querySelector("script, iframe, img")).toBeNull();
  expect(view.queryByRole("list")).toBeNull();
});

it("shows compact source-reported facts as labelled values, never executable markup", () => {
  const view = renderCard({ type: "facts", title: "Key facts", items: [{ label: "Duration", value: "3.6 s" }, { label: "Source", value: "<img src=x>" }] });
  expect(view.getAllByRole("term").map(term => term.textContent)).toEqual(["Duration", "Source"]);
  expect(view.getAllByRole("definition").map(value => value.textContent)).toEqual(["3.6 s", "<img src=x>"]);
  expect(view.getByText("Reported by Pi")).toBeTruthy();
  expect(view.container.querySelector("img, script, iframe")).toBeNull();
});

it("makes before and after states visible together with safe Markdown", () => {
  const view = renderCard({ type: "comparison", title: "What changed", before: "A **long wait**.", after: "A short wait. <script>bad()</script>" });
  expect(view.getByText("Before")).toBeTruthy();
  expect(view.getByText("After")).toBeTruthy();
  expect(view.container.querySelector("strong")?.textContent).toBe("long wait");
  expect(view.queryByRole("button", { name: "Expand" })).toBeNull();
  expect(view.container.querySelector("script, iframe")).toBeNull();
});

it("draws a labelled, read-only process flow with ordered nodes", () => {
  const view = renderCard({ type: "flow", title: "Answer path", items: ["Pi works", "**Formatter**", "Simple answer"] });
  const flow = view.getByRole("list", { name: "Process flow: Answer path" });
  expect(flow.tagName).toBe("OL");
  expect(within(flow).getAllByRole("listitem").map(item => item.querySelector(".simple-response-flow-node")?.textContent?.trim())).toEqual(["Pi works", "Formatter", "Simple answer"]);
  expect(flow.querySelectorAll(".simple-response-flow-arrow")).toHaveLength(2);
  expect(flow.querySelector("strong")?.textContent).toBe("Formatter");
  expect(within(flow).queryByRole("button")).toBeNull();
});

it("keeps optional details collapsed in a native disclosure with safe Markdown", async () => {
  const view = renderCard({ type: "details", title: "How it works", text: "**Session cookies** stay private.\n\n```html preview\n<script>unsafe()</script>\n```" });
  const summary = view.getByText("How it works");
  const details = summary.closest("details")!;
  expect(summary.tagName).toBe("SUMMARY");
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  await fireEvent.click(summary); flush();
  expect(details.open).toBe(true);
  expect(details.querySelector("strong")?.textContent).toBe("Session cookies");
  expect(details.querySelector("script, iframe")).toBeNull();
  await fireEvent.click(summary); flush();
  expect(details.open).toBe(false);
});

it("labels each Pi-reported check outcome without interactive checkboxes", () => {
  const view = renderCard({ type: "checks", title: "Verification", items: [
    { status: "passed", text: "**Build** completed." }, { status: "failed", text: "One test failed." },
    { status: "skipped", text: "Browser test skipped." }, { status: "unverified", text: "Live model not checked." },
  ] });
  expect(view.getByText("Reported by Pi")).toBeTruthy();
  const rows = view.getAllByRole("listitem");
  for (const [index, label] of ["Passed", "Failed", "Skipped", "Unverified"].entries()) expect(rows[index].textContent).toContain(label);
  expect(rows[0].querySelector("strong")?.textContent).toBe("Build");
  expect(view.queryByRole("checkbox")).toBeNull();
});

it("renders next steps as an ordered, read-only sequence with Markdown", () => {
  const view = renderCard({ type: "steps", title: "Get started", items: ["**Save** settings.", "Restart pi-web."] });
  const list = view.getByRole("list");
  expect(list.tagName).toBe("OL");
  expect(view.getAllByRole("listitem").map(item => item.textContent?.trim())).toEqual(["Save settings.", "Restart pi-web."]);
  expect(list.querySelector("strong")?.textContent).toBe("Save");
  expect(view.queryByRole("checkbox")).toBeNull();
});

it("makes warnings visible without an interrupting alert or executable markup", () => {
  const view = renderCard({ type: "warning", title: "Before deployment", text: "**Back up** the database. <script>unsafe()</script>" });
  expect(view.getByRole("heading", { name: "Warning: Before deployment" })).toBeTruthy();
  expect(view.container.querySelector("strong")?.textContent).toBe("Back up");
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.container.querySelector("script, iframe")).toBeNull();
  expect(view.queryByText("Original answer")).toBeNull();
});
