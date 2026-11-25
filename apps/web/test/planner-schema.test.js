import { expect, test } from "vitest";
import register, { schema } from "../../server/pi/planner-schema";
import responseFixtures from "../../shared/fixtures/response-components.json";

function request(provider, api) {
  const handlers = {};
  register({ on: (event, handler) => { handlers[event] = handler; } });
  const ctx = { model: { provider, api } };
  const systemPrompt = "Write clearly.";
  const payload = { input: ["Original reply"], text: { verbosity: "low" } };
  return {
    prompt: handlers.before_agent_start({ systemPrompt }, ctx)?.systemPrompt ?? systemPrompt,
    body: handlers.before_provider_request({ payload }, ctx) ?? payload,
  };
}

test("Responses requests carry a strict schema without repeating it in the instructions", () => {
  for (const [provider, api] of [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"]]) {
    const { prompt, body } = request(provider, api);
    expect(prompt).toBe("Write clearly.");
    expect(body.input).toEqual(["Original reply"]);
    expect(body.text.verbosity).toBe("low");
    expect(body.text.format).toEqual({ type: "json_schema", name: "simple_response", strict: true, schema });
    expect(schema.properties).not.toHaveProperty("recorded");
  }
});

test("the strict formatter schema requires a title and text on each comparison side", () => {
  const { body } = request("openai", "openai-responses");
  const comparison = body.text.format.schema.$defs.block.anyOf.find(block => block.properties.type.enum.includes("comparison"));
  const side = {
    type: "object", properties: { title: { type: "string" }, text: { type: "string" } },
    required: ["title", "text"], additionalProperties: false,
  };
  expect(comparison.required).toEqual(["type", "title", "mode", "left", "right"]);
  expect(comparison.properties).toEqual({
    type: { type: "string", enum: ["comparison"] }, title: { type: "string" },
    mode: { type: "string", enum: ["alternatives", "change"] }, left: side, right: side,
  });
  for (const fixture of responseFixtures.comparisons.blocks) {
    expect(Object.keys(fixture).sort()).toEqual([...comparison.required].sort());
    expect(comparison.properties.mode.enum).toContain(fixture.mode);
  }
});

test("composed comparison sides refer to ordered native blocks rather than generated markup", () => {
  const node = schema.$defs.node.anyOf.find(o => o.properties.type.enum.includes("comparison_panels"));
  expect(node.required).toEqual(["type", "mode", "left", "right"]);
  expect(node.properties.mode.enum).toEqual(["alternatives", "change"]);
  expect(node.properties.left).toEqual({ $ref: "#/$defs/panel" });
  expect(node.properties.right).toEqual(node.properties.left);
  expect(schema.$defs.panel.required).toEqual(["title", "blocks"]);
  expect(schema.$defs.panel.properties.blocks).toEqual({ type: "array", minItems: 1, items: { type: "integer", minimum: 0 } });
});

test("the planner can attach an optional typed annotation to each path step", () => {
  const path = schema.$defs.block.anyOf.find(block => block.properties.type.enum.includes("path"));
  expect(path?.required).toEqual(["type", "title", "status", "groups"]);
  const group = path.properties.groups.items;
  expect(group.required).toEqual(["label", "steps"]);
  const step = group.properties.steps.items;
  expect(step.required).toEqual(["text", "annotation"]);
  const [annotation, nil] = step.properties.annotation.anyOf;
  expect(nil).toEqual({ type: "null" });
  expect(annotation.additionalProperties).toBe(false);
  expect(annotation.properties.kind.enum).toEqual(["context", "cost", "risk"]);
});

test("formatter tables require a purpose separate from visible headings", () => {
  const options = request("openai", "openai-responses").body.text.format.schema.$defs.block.anyOf;
  const table = options.find(block => block.properties.type.enum.includes("table"));
  expect(table.required).toContain("purpose");
  expect(table.properties.purpose.enum).toEqual(["data", "decision", "conditional"]);
  for (const fixture of responseFixtures.tables.blocks) {
    expect(Object.keys(fixture).sort()).toEqual([...table.required].sort());
    expect(table.properties.purpose.enum).toContain(fixture.purpose);
  }
});

test("other providers receive the same schema without an unsupported request option", () => {
  const { prompt, body } = request("custom", "openai-responses");
  expect(prompt.startsWith("Write clearly.")).toBe(true);
  expect(JSON.parse(prompt.slice(prompt.indexOf("{")))).toEqual(schema);
  expect(body.text).not.toHaveProperty("format");
});
