// Loaded only in the isolated presentation process. The Rust decoder still owns
// semantic checks (e.g. evidence IDs, graph edges, and canvas block indices).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Shape = Record<string, unknown>;
const text = { type: "string" };
const nil = { type: "null" };
const nullable = (shape: Shape) => ({ anyOf: [shape, nil] });
const list = (items: Shape) => ({ type: "array", items });
const choices = (...values: string[]) => ({ type: "string", enum: values });
// Strict OpenAI schemas require every key. Nullable fields become None in Rust.
const object = (properties: Record<string, Shape>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const block = (type: Shape, fields: Record<string, Shape>) => object({ type, title: text, ...fields });
const strings = list(text);
const comparisonSide = object({ title: text, text });
const pathStep = object({ text, annotation: nullable(object({ kind: choices("context", "cost", "risk"), text })) });
const node = { $ref: "#/$defs/node" };
const panel = { $ref: "#/$defs/panel" };
const comparisonMode = choices("alternatives", "change");
const children = list(node);
const index = { type: "integer", minimum: 0 };
export const schema = {
  ...object({ summary: text, summarySource: nullable(text), blocks: list({ $ref: "#/$defs/block" }), canvas: nullable(object({
    layout: choices("answer", "result", "explanation", "investigation", "review", "plan", "comparison"),
    headline: nullable(text), focus: nullable(index), composition: nullable(node),
  })) }),
  $defs: {
    panel: object({ title: text, blocks: { ...list(index), minItems: 1 } }),
    node: { anyOf: [
      object({ type: choices("comparison_panels"), mode: comparisonMode, left: panel, right: panel }),
      object({ type: choices("block"), index }), object({ type: choices("stack"), children }),
      object({ type: choices("section"), title: text, children }),
      object({ type: choices("columns"), ratio: choices("equal", "leading"), children: { ...children, minItems: 2, maxItems: 2 } }),
    ] },
    block: { anyOf: [
      block(choices("steps", "checklist", "flow", "evidence"), { items: strings }),
      block(choices("note", "details", "warning"), { text }),
      block(choices("code"), { language: nullable(text), code: text }),
      block(choices("comparison"), { mode: comparisonMode, left: comparisonSide, right: comparisonSide }),
      block(choices("facts"), { items: list(object({ label: text, value: text })) }),
      block(choices("chart"), { unit: text, items: list(object({ label: text, value: text })) }),
      block(choices("table"), { purpose: choices("data", "decision", "conditional"), columns: strings, rows: list(strings) }),
      block(choices("checks"), { items: list(object({ status: choices("passed", "failed", "skipped", "unverified"), text, source: nullable(text) })) }),
      block(choices("path"), { status: nullable(text), groups: list(object({ label: text, steps: list(pathStep) })) }),
      block(choices("timeline"), { items: list(object({ kind: choices("reported", "hypothesis", "next"), label: text, text })) }),
      block(choices("findings"), { items: list(object({ severity: choices("critical", "high", "medium", "low"), title: text, text, location: nullable(text) })) }),
      block(choices("diagram"), {
        nodes: list(object({ id: text, label: text, kind: choices("input", "process", "store", "decision", "output") })),
        edges: list(object({ from: text, to: text, label: text, relation: choices("direct", "hypothesis") })),
      }),
    ] },
  },
};

function native(model?: { provider: string; api: string }) {
  return (model?.provider === "openai" && model.api === "openai-responses") ||
    (model?.provider === "openai-codex" && model.api === "openai-codex-responses");
}

export default function plannerSchema(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    if (!native(ctx.model)) return { systemPrompt: `${event.systemPrompt}\n\nReturn JSON matching this schema:\n${JSON.stringify(schema)}` };
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!native(ctx.model)) return;
    const payload = event.payload as { text?: Record<string, unknown> };
    return { ...payload, text: { ...payload.text, format: { type: "json_schema", name: "simple_response", strict: true, schema } } };
  });
}
