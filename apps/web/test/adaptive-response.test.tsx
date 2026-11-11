import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { SimpleResponse } from "../src/components/SimpleResponse";
import { responseText } from "../src/response-copy";
import { decodeServer, initialState } from "../src/client-state";
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
  const view = render(() => <SimpleResponse message={message} original={() => <p>Original stays separate.</p>} openCode={openCode} />);
  flush(); return { ...view, openCode };
}
function wire(response: unknown) {
  return JSON.stringify({ v: 1, sessionId: "s", epoch: "e", body: { type: "snapshot", throughSeq: 1, status: initialState().status,
    messages: [{ id: "answer", role: "assistant", complete: true, error: null, truncated: false, blocks: [], presentation: { state: "ready", response } }], dialogs: [], olderHistory: false } });
}

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
  fireEvent.click(view.getByRole("button", { name: "Open src/session.ts in Changes" }));
  expect(view.openCode).toHaveBeenCalledWith({ path: "src/session.ts", line: 1, endLine: 1 });
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
    { type: "comparison", title: text, before: text, after: text },
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
