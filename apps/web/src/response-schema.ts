import type { SimpleResponse } from "./generated/protocol";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const filled = (v: unknown): v is string => text(v) && v.trim().length > 0;
const list = (v: unknown, min: number, check: (item: unknown) => boolean): v is unknown[] => Array.isArray(v) && v.length >= min && v.every(check);
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const oneOf = (v: unknown, values: readonly string[]) => typeof v === "string" && values.includes(v);
const id = (v: unknown): v is string => filled(v) && /^[A-Za-z0-9_-]+$/.test(v);
const ref = (v: unknown): v is string => typeof v === "string" && /^(?:tool|file):(?:0|[1-9][0-9]*)$/.test(v);
const unique = (values: unknown[]) => new Set(values).size === values.length;
const encoder = new TextEncoder();
// Recorded observations retain their server-owned collection and metadata budgets.
const bounded = (v: unknown, max: number): v is string => filled(v) && encoder.encode(v).length <= max;
const path = (v: unknown): v is string => bounded(v, 512) && !/[\p{Cc}]/u.test(v) && !v.startsWith("/") && v.split("/").every(part => !!part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

function card(v: unknown): boolean {
  if (!object(v) || !filled(v.title)) return false;
  switch (v.type) {
    case "checklist": case "steps": case "flow": return list(v.items, 1, filled);
    case "facts": return list(v.items, 1, item => object(item) && filled(item.label) && filled(item.value));
    case "comparison": return filled(v.before) && filled(v.after);
    case "code": return text(v.code) && v.code.length > 0 && (v.language === undefined || text(v.language));
    case "table": {
      const columns = v.columns;
      return list(columns, 1, filled) && list(v.rows, 1, row => list(row, columns.length, filled) && row.length === columns.length);
    }
    case "diagram": {
      if (!list(v.nodes, 1, node => object(node) && id(node.id) && filled(node.label) && oneOf(node.kind, ["input", "process", "store", "decision", "output"]))) return false;
      const ids = v.nodes.map(node => (node as Obj).id);
      return unique(ids) && list(v.edges, 0, edge => object(edge) && ids.includes(edge.from) && ids.includes(edge.to) && text(edge.label) && oneOf(edge.relation, ["direct", "hypothesis"]));
    }
    case "chart": return filled(v.unit) && list(v.items, 1, item => object(item) && filled(item.label) && filled(item.value)
      && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(item.value) && Number.isFinite(Number(item.value)));
    case "timeline": return list(v.items, 1, item => object(item) && filled(item.label) && filled(item.text) && oneOf(item.kind, ["reported", "hypothesis", "next"]));
    case "findings": return list(v.items, 1, item => object(item) && oneOf(item.severity, ["critical", "high", "medium", "low"])
      && filled(item.title) && filled(item.text) && (item.location === undefined || filled(item.location)));
    case "evidence": return list(v.items, 1, ref) && unique(v.items);
    case "checks": return list(v.items, 1, item => object(item) && oneOf(item.status, ["passed", "failed", "skipped", "unverified"]) && filled(item.text));
    case "note": case "warning": case "details": return filled(v.text);
    default: return false;
  }
}

function recorded(v: unknown): boolean {
  if (!object(v) || !oneOf(v.filesState, ["captured", "unavailable"]) || typeof v.omittedTools !== "boolean" || typeof v.omittedFiles !== "boolean") return false;
  if (!list(v.tools, 0, tool => object(tool) && bounded(tool.label, 80) && oneOf(tool.outcome, ["completed", "error", "unconfirmed"]) && integer(tool.durationMs))
    || v.tools.length > 12 || !v.tools.every((tool, index) => object(tool) && tool.id === `tool:${index}`)) return false;
  if (!list(v.files, 0, file => object(file) && path(file.path) && oneOf(file.change, ["added", "modified", "deleted"])
    && ((file.added === null && file.removed === null) || (integer(file.added, 0xffffffff) && integer(file.removed, 0xffffffff))))
    || v.files.length > 8 || !v.files.every((file, index) => object(file) && file.id === `file:${index}`)) return false;
  return !v.files.length || v.filesState === "captured";
}

/** Accepts structurally valid response plans and resolves every evidence reference
 * against server-supplied observations before graphical components are mounted. */
export function validResponse(v: unknown): v is SimpleResponse {
  if (!object(v) || !filled(v.summary) || !list(v.blocks, 0, card) || (v.recorded !== undefined && !recorded(v.recorded))) return false;
  if (v.canvas !== undefined) {
    const plan = v.canvas;
    if (!object(plan) || !oneOf(plan.layout, ["answer", "result", "explanation", "investigation", "review", "plan", "comparison"]) || !filled(plan.headline)) return false;
    if (plan.focus !== null && (!integer(plan.focus, v.blocks.length - 1) || (v.blocks[plan.focus] as Obj).type === "details")) return false;
  }
  const data = v.recorded as SimpleResponse["recorded"];
  const ids = new Set([...(data?.tools ?? []), ...(data?.files ?? [])].map(item => item.id));
  return v.blocks.every(block => (block as Obj).type !== "evidence" || ((block as Obj).items as string[]).every(id => ids.has(id)));
}
