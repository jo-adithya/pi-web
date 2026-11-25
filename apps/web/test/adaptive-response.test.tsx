import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { SimpleResponse } from "../src/components/SimpleResponse";
import { responseText } from "../src/response-copy";
import { decodeServer, initialState } from "../src/client-state";
import responseFixtures from "../../shared/fixtures/response-components.json";
import type { CanvasLayout, DisplayMessage, RecordedEvidence, SimpleResponse as Response } from "../src/generated/protocol";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const diagram: Response["blocks"][number] = { type: "diagram", title: "Session routing", nodes: [
  { id: "server", label: "Server", kind: "process" }, { id: "a", label: "Session A", kind: "store" }, { id: "b", label: "Session B", kind: "output" },
], edges: [
  { from: "server", to: "a", label: "first route", relation: "direct" },
  { from: "server", to: "b", label: "second route", relation: "direct" },
  { from: "b", to: "server", label: "possible retry", relation: "hypothesis" },
] };
const recorded: RecordedEvidence = { filesState: "captured", omittedFiles: false, omittedTools: false,
  files: [{ id: "file:0", path: "src/session.ts", change: "modified", added: 2, removed: 1 }],
  tools: [{ id: "tool:0", label: "Shell tool", outcome: "error", durationMs: 20 }],
};
function show(response: Response, openCode = vi.fn()) {
  const message: DisplayMessage = { id: "answer", role: "assistant", complete: true, error: null, truncated: false, blocks: [], presentation: { state: "ready", response } };
  const view = render(() => <SimpleResponse message={message} original={() => ({ render: () => <p>Original stays separate.</p>, text: "Original stays separate." })} openCode={openCode} />);
  flush(); return { ...view, openCode };
}
function wire(response: unknown) {
  return JSON.stringify({ v: 1, sessionId: "s", epoch: "e", body: { type: "snapshot", throughSeq: 1, status: initialState().status,
    messages: [{ id: "answer", role: "assistant", complete: true, error: null, truncated: false, blocks: [], presentation: { state: "ready", response } }], dialogs: [], olderHistory: false } });
}
function decodeReply(response: unknown): Response {
  const frame = decodeServer(wire(response));
  const presentation = frame?.body.type === "snapshot" ? frame.body.messages[0].presentation : undefined;
  if (presentation?.state !== "ready") throw new Error("Expected a ready presentation");
  return presentation.response;
}

it("shows and copies the summary without an empty headline", () => {
  const response: Response = { summary: "Still readable.", canvas: { layout: "result", focus: null }, blocks: [] };
  expect(() => decodeServer(wire(response))).not.toThrow();
  const view = show(response);
  expect(view.getByText("Still readable.")).toBeTruthy();
  expect(view.container.querySelector("h2")).toBeNull();
  expect(responseText(response)).toBe("Still readable.");
});

it("keeps mixed native blocks inside named comparison panels and copies them in panel order", () => {
  const response = decodeReply(responseFixtures.composedComparison);
  const view = show(response);
  const left = view.getByRole("region", { name: "Current" }), right = view.getByRole("region", { name: "Proposed" });
  expect(within(left).getByRole("list", { name: "List" })).toBeTruthy();
  expect(left.querySelector("pre code")?.textContent).toBe("return mayCall(tool);");
  expect(within(right).getByText("Design only")).toBeTruthy();
  expect(right.querySelector("blockquote")?.textContent).toContain("Use the same verdict for listing and calling.");
  const shared = view.getByText("No tests were run.");
  expect(left.contains(shared) || right.contains(shared)).toBe(false);
  const text = responseText(response);
  const parts = ["One access decision", "Current", "Separate decisions", "Call site", "```js\nreturn mayCall(tool);\n```", "Proposed\n", "Shared decision (Design only)", "> Use the same verdict", "Verification", "No tests were run."];
  const positions = parts.map(part => text.indexOf(part));
  expect(positions.every((n, i) => n >= 0 && (!i || n > positions[i - 1]))).toBe(true);
});

it("uses neutral panels for alternatives without inferring a change from titles", () => {
  const composition = { type: "comparison_panels", mode: "alternatives", left: { title: "Before", blocks: [0] }, right: { title: "After", blocks: [1] } };
  const response = decodeReply({ summary: "Two named alternatives.", blocks: responseFixtures.composedComparison.blocks.slice(0, 2), canvas: { layout: "explanation", focus: null, composition } });
  const view = show(response);
  expect(view.getByRole("region", { name: "Before" }).parentElement?.dataset.mode).toBe("alternatives");
  expect(view.getByRole("region", { name: "After" }).textContent).toContain("Separate decisions");
});

it("rejects empty, duplicated, missing and out-of-range comparison panel references", () => {
  const { summary, blocks } = responseFixtures.composedComparison;
  for (const [before, after] of [[[], [1, 2, 3, 4]], [[0, 1], [1, 2, 3, 4]], [[0, 1], [2, 3]], [[0, 1], [2, 3, 4, 5]]]) {
    const composition = { type: "comparison_panels", mode: "alternatives", left: { title: "A", blocks: before }, right: { title: "B", blocks: after } };
    expect(() => decodeServer(wire({ summary, blocks, canvas: { layout: "comparison", focus: null, composition } }))).toThrow("Invalid server message");
  }
});

it("renders native paths in paired columns and copies annotations with their step", () => {
  const response = decodeReply(responseFixtures.paths);
  const view = show(response);
  expect(view.container.querySelectorAll('.response-composition-columns > [data-component="path"]')).toHaveLength(2);
  expect(view.getByRole("heading", { name: "One access decision" })).toBeTruthy();
  const steps = within(view.getByRole("list", { name: "Call a tool" })).getAllByRole("listitem");
  expect(steps[0].textContent).toContain("Cost: 2 queries");
  expect(steps[1].querySelector("code")?.textContent).toBe("mayCall");
  expect(view.getByText("Design only").closest("section")?.textContent).toContain("Return one verdict.");
  expect(responseText(response)).toContain("Call a tool\n1. Read the rules. — Cost: 2 queries\n2. Evaluate `mayCall`.");
  expect(responseText(response)).toContain("Shared decision (Design only)");
  expect(responseText(response)).toContain("Risk: Decisions can disagree");
  expect(view.container.querySelector("iframe")).toBeNull();
});

it("accepts a standalone path but rejects empty groups, missing steps and malformed annotations", () => {
  const path = responseFixtures.paths.blocks[0];
  const reply = (block: unknown) => ({ summary: "One path", blocks: [block] });
  expect(decodeReply(reply(path)).blocks).toHaveLength(1);
  for (const groups of [[], [{ label: "Entry", steps: [] }], [{ label: "Entry", steps: [{ text: "Read", annotation: { kind: "verified", text: "done" } }] }]]) {
    expect(() => decodeServer(wire(reply({ ...path, groups })))).toThrow("Invalid server message");
  }
});

it("shows and copies the two option titles instead of Before and After", () => {
  const response = decodeReply({ summary: "Atlas discovers data differently for each source.", blocks: [responseFixtures.comparisons.blocks[1]] });
  const view = show(response);
  expect(view.getByRole("heading", { name: "How Atlas discovers data" })).toBeTruthy();
  expect(view.getAllByRole("heading", { level: 4 }).map(heading => heading.textContent)).toEqual(["Postgres", "Maximo"]);
  expect(view.container.querySelector("strong")?.textContent).toBe("tables and columns");
  expect(view.container.querySelector("code")?.textContent).toBe("maximo_query");
  expect(responseText(response)).toBe([
    "Atlas discovers data differently for each source.", "How Atlas discovers data",
    "Postgres:", "Atlas can list **tables and columns**.", "Maximo:", "Atlas can see a `maximo_query` tool.",
  ].join("\n\n"));
});

it("keeps a comparison's mode when its display titles are renamed", () => {
  const response = decodeReply({ summary: "Proposal only.", blocks: [responseFixtures.comparisons.blocks[0]] });
  const view = show(response);
  expect(view.getByRole("heading", { name: "Current" })).toBeTruthy();
  expect(view.getByRole("heading", { name: "Proposed" })).toBeTruthy();
  expect(view.container.querySelector(".simple-response-comparison")?.getAttribute("data-mode")).toBe("change");
  expect(responseText(response)).toContain("Proposed:\n\nRequests reuse a **shared** connection.");
});

it("keeps custom conditional and decision headings attached to their rows", () => {
  const { summary, blocks } = responseFixtures.tables;
  const response = decodeReply({ summary, blocks });
  const view = show(response);
  const conditions = within(view.getByRole("table", { name: "Restart rules" }));
  const otherwise = conditions.getByRole("row", { name: "Otherwise Leave the service running" });
  expect([...otherwise.querySelectorAll(".simple-table-label")].map(label => label.textContent)).toEqual(["Condition", "Action"]);
  const choices = within(view.getByRole("table", { name: "Storage choices" }));
  expect(choices.getByRole("rowheader", { name: "Database" })).toBeTruthy();
  expect(responseText(response)).toContain("| Otherwise | Leave the service running |");
});

it("renders mixed composables in source order and copies section headings", () => {
  const response: Response = { summary: "A mixed result.", canvas: { layout: "result", headline: "Grouped result", focus: null,
    composition: { type: "stack", children: [
      { type: "section", title: "Investigation context", children: [{ type: "block", index: 1 }] },
      { type: "columns", ratio: "leading", children: [{ type: "block", index: 2 }, { type: "block", index: 0 }] },
    ] } }, blocks: [
      { type: "details", title: "Optional", text: "Extra detail." },
      { type: "warning", title: "Risk", text: "Still visible." },
      diagram,
    ] };
  expect(decodeServer(wire(response))).not.toBeNull();
  const view = show(response);
  expect(view.getByRole("heading", { name: "Investigation context" })).toBeTruthy();
  expect(view.container.querySelectorAll('.response-composition-columns > *')).toHaveLength(2);
  const blocks = [...view.container.querySelectorAll(".response-canvas-block")];
  expect(blocks.map(block => block.getAttribute("data-component"))).toEqual(["warning", "diagram", "details"]);
  expect(view.getByText("Still visible.").closest("details")).toBeNull();
  const text = responseText(response);
  expect(text.indexOf("Investigation context")).toBeLessThan(text.indexOf("Warning: Risk"));
  expect(text.indexOf("Session routing")).toBeLessThan(text.indexOf("Optional"));
});

it("rejects invalid composition references, shapes and excessive nesting", () => {
  const base = { summary: "Result", canvas: { layout: "result", headline: "Result", focus: null, composition: {} }, blocks: [diagram] };
  for (const composition of [
    { type: "block", index: 1 },
    { type: "stack", children: [] },
    { type: "stack", children: [{ type: "block", index: 0 }, { type: "block", index: 0 }] },
    { type: "columns", ratio: "equal", children: [{ type: "block", index: 0 }] },
    { type: "section", title: " ", children: [{ type: "block", index: 0 }] },
    { type: "disclosure", children: [{ type: "block", index: 0 }] },
  ]) {
    expect(() => decodeServer(wire({ ...base, canvas: { ...base.canvas, composition } }))).toThrow("Invalid server message");
  }
  let nested: unknown = { type: "block", index: 0 };
  for (let i = 0; i < 6; i++) nested = { type: "stack", children: [nested] };
  expect(() => decodeServer(wire({ ...base, canvas: { ...base.canvas, composition: nested } }))).toThrow("Invalid server message");
});

it.each<CanvasLayout>(["result", "explanation", "investigation", "review", "plan", "comparison"])("composes a %s canvas around one dominant visual", layout => {
  const view = show({ summary: "Each request reaches its own session.", canvas: { layout, headline: "Sessions stay separate", focus: 1 }, blocks: [
    { type: "note", title: "Supporting context", text: "One server owns the runtimes." }, diagram,
  ] });
  expect(view.getByRole("heading", { name: "Sessions stay separate" })).toBeTruthy();
  const canvas = view.container.querySelector("[data-layout]")!;
  expect(canvas.getAttribute("data-layout")).toBe(layout);
  const blocks = canvas.querySelectorAll(".response-canvas-block");
  expect(blocks[0].classList.contains("is-focus")).toBe(true);
  expect(blocks[0].textContent).toContain("Session routing");
  expect(view.queryByText("Original stays separate.")).toBeNull();
});

it.each([null, 0])("keeps a warning-only focus from leaving an empty primary column (%s)", focus => {
  const view = show({ summary: "There is a limitation.", canvas: { layout: "result", headline: "Check before proceeding", focus }, blocks: [
    { type: "warning", title: "Important", text: "Keep this visible." }, { type: "note", title: "Context", text: "A short explanation." },
  ] });
  expect(view.container.querySelector(".response-canvas-body")?.classList.contains("has-focus")).toBe(false);
  expect(view.getByText("Keep this visible.")).toBeTruthy();
});
it("gives a lone primary block the full composition width", () => {
  const view = show({ summary: "A short result.", canvas: { layout: "result", headline: "One useful visual", focus: 0 }, blocks: [diagram] });
  const body = view.container.querySelector(".response-canvas-body")!;
  expect(body.classList.contains("has-focus")).toBe(true);
  expect(body.classList.contains("has-support")).toBe(false);
});

it("draws branches and a return connection without inventing a linear path", () => {
  const view = show({ summary: "Routes can branch.", blocks: [diagram] });
  const graphic = view.getByRole("img", { name: "Session routing" });
  expect(graphic.querySelectorAll(".response-diagram-edge")).toHaveLength(3);
  expect(graphic.querySelectorAll('[data-relation="hypothesis"]')).toHaveLength(1);
  for (const text of ["Server", "Session A", "Session B"]) expect(within(graphic).getByText(text)).toBeTruthy();
  expect(view.getByText(/Dashed links are hypotheses/)).toBeTruthy();
  expect(view.container.querySelector("script, iframe, foreignObject")).toBeNull();
});

it("prioritizes severe findings and treats SVG labels as literal text", () => {
  const view = show({ summary: "Review the highest-impact issue first.", blocks: [
    { type: "findings", title: "Review", items: [
      { severity: "low", title: "Small issue", text: "Supporting detail." },
      { severity: "critical", title: "Important issue", text: "A concrete risk." },
    ] },
    { type: "diagram", title: "Literal labels", nodes: [{ id: "a", kind: "process", label: "<script>bad()</script>" }], edges: [] },
  ] });
  const findings = view.getByRole("list", { name: "Review" });
  expect(within(findings).getAllByRole("listitem")[0].textContent).toContain("Important issue");
  expect(view.getByRole("img", { name: "Literal labels" }).querySelector(".response-node-label")?.textContent).toBe("<script>bad()</script>");
  expect(view.container.querySelector("script, foreignObject")).toBeNull();
});

it("keeps file-only, nonlocal and invalid finding locations as literal text", () => {
  const references = ["src/main.ts", "/tmp/example.ts:2", "../outside.ts:2", "https://example.test/change#L2", "src/main.ts:8-4"];
  const view = show({ summary: "Sources to verify.", blocks: [{ type: "findings", title: "Findings", items: references.map(location => ({
    severity: "medium", title: "A finding", text: "A source label alone does not identify a valid workspace line.", location,
  })) }] });
  const list = within(view.getByRole("list", { name: "Findings" }));
  for (const location of references) expect(list.getByText(location).textContent).toBe(location);
  expect(list.queryAllByRole("button")).toHaveLength(0);
  expect(list.queryAllByRole("link")).toHaveLength(0);
});

it("uses a wide diagram on desktop and a readable single column on narrow screens", () => {
  let resize: (entries: { contentRect: { width: number } }[]) => void = () => {};
  vi.stubGlobal("ResizeObserver", class { constructor(callback: typeof resize) { resize = callback; } observe() {} disconnect() {} });
  const view = show({ summary: "Routing example.", blocks: [diagram] });
  resize([{ contentRect: { width: 640 } }]); flush();
  const svg = view.getByRole("img", { name: "Session routing" });
  const wide = svg.getAttribute("viewBox")!.split(" ").map(Number);
  expect(wide[2]).toBeGreaterThan(wide[3]);
  resize([{ contentRect: { width: 300 } }]); flush();
  const narrow = svg.getAttribute("viewBox")!.split(" ").map(Number);
  expect(narrow[2]).toBe(260);
  expect(narrow[3]).toBeGreaterThan(narrow[2]);
  expect(svg.querySelectorAll(".response-diagram-edge")).toHaveLength(3);
});

it("copies adaptive reading order, graph uncertainty and exact chart values", () => {
  const text = responseText({ summary: "A short result.", canvas: { layout: "explanation", headline: "Core result", focus: 2 }, recorded,
    blocks: [{ type: "details", title: "Optional context", text: "Extra detail." },
      { type: "warning", title: "Visible risk", text: "Keep this visible." }, diagram,
      { type: "chart", title: "Delay", unit: "s", items: [{ label: "A", value: "3.60" }] }] });
  expect(text.startsWith("Core result\n\nA short result.")).toBe(true);
  expect(text).toContain("Session B → Server: possible retry (hypothesis)");
  expect(text).toContain("A: 3.60 s");
  expect(text).toContain("May include recovered errors");
  expect(text.indexOf("Warning: Visible risk")).toBeLessThan(text.indexOf("Session routing (reported by Pi)"));
  expect(text.indexOf("Delay (reported by Pi)")).toBeLessThan(text.indexOf("Optional context"));
  const findings = responseText({ summary: "Review.", blocks: [{ type: "findings", title: "Findings", items: [
    { severity: "low", title: "Small issue", text: "Detail." }, { severity: "critical", title: "Main issue", text: "Risk.", location: "file.ts:2" },
  ] }, { type: "timeline", title: "Trace", items: [{ label: "Cause", text: "Not established.", kind: "hypothesis" }] }] });
  expect(findings.indexOf("CRITICAL: Main issue (file.ts:2)")).toBeLessThan(findings.indexOf("LOW: Small issue"));
  expect(findings).toContain("Hypothesis — Cause: Not established.");
});

it("preserves chart precision and a true zero baseline", () => {
  const view = show({ summary: "B has the shorter reported delay.", blocks: [{ type: "chart", title: "Delay", unit: "s", items: [
    { label: "A", value: "3.60" }, { label: "B", value: "1.2" }, { label: "C", value: "0" },
  ] }] });
  expect(view.getByText("3.60 s")).toBeTruthy();
  expect(view.getByText("0 s")).toBeTruthy();
  const bars = view.container.querySelectorAll<HTMLElement>(".response-bar-fill");
  expect(bars[0].style.width).toBe("100%");
  expect(parseFloat(bars[1].style.width)).toBeCloseTo(100 / 3);
  expect(bars[2].style.width).toBe("0%");
});

it.each([true, false])("pins observed tool errors even without an evidence block (canvas: %s)", canvas => {
  const view = show({ summary: "The result is ready.", canvas: canvas ? { layout: "result", headline: "Work completed", focus: null } : undefined, blocks: [], recorded });
  expect(view.getByText("1 tool error during work")).toBeTruthy();
  expect(view.getByText(/May include recovered errors/)).toBeTruthy();
  expect(view.queryByText(/Tests passed/)).toBeNull();
});

it("binds file and tool references to recorded data and opens the current Changes view", () => {
  const view = show({ summary: "A file changed.", canvas: { layout: "result", headline: "Session update", focus: 0 }, recorded,
    blocks: [{ type: "evidence", title: "Recorded work", items: ["file:0", "tool:0"] }] });
  expect(view.getByText("+2")).toBeTruthy(); expect(view.getByText("−1")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Preview src/session.ts" }));
  expect(view.openCode).toHaveBeenCalledWith({ path: "src/session.ts", line: 1, endLine: 1 }, expect.any(HTMLButtonElement));
  expect(view.getByText(/Concurrent edits may be included/)).toBeTruthy();
  expect(view.getByText(/not proof that tests passed/)).toBeTruthy();
});

it("accepts large content at the browser boundary and renders every node and table row", () => {
  const long = "Useful label ".repeat(40);
  const nodes = Array.from({ length: 20 }, (_, index) => ({ id: `node_${index}_${"x".repeat(30)}`, label: `Label ${index}`, kind: "process" as const }));
  const response: Response = { summary: long, canvas: { layout: "answer", headline: long, focus: 0 }, blocks: [
    { type: "diagram", title: "Large diagram", nodes, edges: nodes.map((node, index) => ({ from: node.id, to: nodes[(index + 1) % nodes.length].id, label: long, relation: "direct" })) },
    { type: "table", title: "Large table", columns: Array.from({ length: 10 }, (_, index) => `Column ${index}`), rows: Array.from({ length: 50 }, (_, row) => Array.from({ length: 10 }, (_, column) => `Row ${row} cell ${column}`)) },
    { type: "steps", title: "Many steps", items: Array.from({ length: 20 }, (_, index) => `Step ${index}: ${long}`) },
    ...Array.from({ length: 6 }, (_, index) => ({ type: "note" as const, title: `Note ${index}`, text: long.repeat(4) })),
  ] };
  expect(() => decodeServer(wire(response))).not.toThrow();
  const view = show(response);
  expect(view.getByRole("img", { name: "Large diagram" }).querySelectorAll(".response-diagram-node")).toHaveLength(20);
  expect(within(view.getByRole("table", { name: "Large table" })).getAllByRole("row")).toHaveLength(51);
  expect(view.getByText("Row 49 cell 9")).toBeTruthy();
  expect(view.getByRole("heading", { name: "Note 5" })).toBeTruthy();
  expect(responseText(response)).toContain("Row 49 cell 9");
});

it("accepts unlimited text and collection sizes for all remaining components", () => {
  const text = "Useful content ".repeat(200);
  const response: Response = { summary: text, blocks: [
    { type: "checklist", title: text, items: Array(20).fill(text) },
    { type: "flow", title: text, items: Array(20).fill(text) },
    { type: "facts", title: text, items: Array(20).fill({ label: text, value: text }) },
    { type: "timeline", title: text, items: Array(20).fill({ label: text, text, kind: "reported" }) },
    { type: "findings", title: text, items: Array(20).fill({ title: text, text, location: text, severity: "high" }) },
    { type: "checks", title: text, items: Array(20).fill({ status: "unverified", text }) },
    { type: "chart", title: text, unit: text, items: Array(20).fill({ label: text, value: "1e100" }) },
    { type: "comparison", title: text, left: { title: text, text }, right: { title: text, text } },
    { type: "details", title: text, text }, { type: "warning", title: text, text },
  ] };
  expect(() => decodeServer(wire(response))).not.toThrow();
  response.blocks = Array.from({ length: 300 }, () => ({ type: "note", title: "Section", text: "Preserved." }));
  response.canvas = { layout: "answer", headline: "All sections", focus: 299 };
  expect(() => decodeServer(wire(response))).not.toThrow();
});

it("keeps signed large chart values finite and on a shared zero baseline", () => {
  const response: Response = { summary: "Signed values.", blocks: [{ type: "chart", title: "Large values", unit: "units", items: [
    { label: "Negative", value: "-1e308" }, { label: "Positive", value: "1e308" }, { label: "Zero", value: "0" },
  ] }] };
  expect(() => decodeServer(wire(response))).not.toThrow();
  const view = show(response);
  const bars = view.container.querySelectorAll<HTMLElement>(".response-bar-fill");
  expect(bars[0].style.width).toBe("50%");
  expect(bars[0].style.marginLeft).toBe("0%");
  expect(bars[1].style.width).toBe("50%");
  expect(bars[1].style.marginLeft).toBe("50%");
  expect(bars[2].style.width).toBe("0%");
});

it("validates plans, graph references, numeric data and evidence bindings at the browser boundary", () => {
  const response: Response = { summary: "The result is ready.", canvas: { layout: "result", headline: "Session update", focus: 0 }, recorded,
    blocks: [diagram, { type: "evidence", title: "Recorded work", items: ["file:0"] }] };
  expect(() => decodeServer(wire(response))).not.toThrow();
  const invalid = [
    { ...response, canvas: { ...response.canvas, focus: 2 } },
    { ...response, canvas: { ...response.canvas, layout: "raw_html" } },
    { ...response, blocks: [{ ...diagram, type: "diagram", nodes: [{ id: "a", label: "A", kind: "process" }], edges: [{ from: "a", to: "missing", label: "bad", relation: "direct" }] }] },
    { ...response, blocks: [{ type: "chart", title: "Bad numbers", unit: "s", items: [{ label: "A", value: "Infinity" }] }] },
    { ...response, blocks: [{ type: "evidence", title: "Fabricated ref", items: ["file:7"] }] },
    { ...response, recorded: { ...recorded, files: [{ ...recorded.files[0], path: "../private" }] } },
  ];
  for (const value of invalid) expect(() => decodeServer(wire(value))).toThrow("Invalid server message");
});
