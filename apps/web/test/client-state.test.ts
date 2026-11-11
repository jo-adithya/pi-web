import { describe, expect, it } from "vitest";
import { applyServer, decodeServer, initialState } from "../src/client-state";
import type { ServerMessage, ServerBody } from "../src/generated/protocol";
const frame = (body: ServerBody, epoch = "e1"): ServerMessage => ({ v: 1, sessionId: "app", epoch, body });
function setup() { const state = initialState(); applyServer(state, frame({ type: "hello", project: "fixture", process: "ready" })); return state; }
const snapshot = (seq = 1, epoch = "e1") => frame({ type: "snapshot", throughSeq: seq, status: initialState().status, messages: [{ id: "m", role: "assistant", blocks: [{ kind: "text", text: "Hi" }], complete: false, error: null, truncated: false }], dialogs: [], olderHistory: false }, epoch);
const delta = (seq: number, text: string, epoch = "e1") => frame({ type: "event", seq, patches: [{ kind: "delta", id: "m", index: 0, thinking: false, text, truncated: false }], status: initialState().status, dialogs: [], olderHistory: false }, epoch);

describe("snapshot and delta consistency", () => {
  it("validates the app-owned simple response vocabulary before rendering", () => {
    const message = snapshot();
    if (message.body.type !== "snapshot") throw new Error("Expected snapshot");
    const raw = JSON.parse(JSON.stringify(message));
    for (const presentation of [{ state: "pending" }, { state: "hidden" }, { state: "error", message: "Try again", retryable: true }, { state: "ready", response: { summary: "Done.", blocks: [{ type: "note", title: "Next", text: "Review it." }] } }]) {
      raw.body.messages[0].presentation = presentation;
      expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    }
    for (const presentation of [null, { state: "unknown" }, { state: "ready", response: { summary: "", blocks: [] } }, { state: "ready", response: { summary: "Done", blocks: [{ type: "html", title: "Run", text: "<script/>" }] } }, { state: "error", message: "é".repeat(257), retryable: true }]) {
      raw.body.messages[0].presentation = presentation;
      expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
    }
  });
  it("validates measured formatting durations and their stage relationships", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const timings = { model: "fixture/cheap", cached: false, totalMs: 3600, queueMs: 20, startupMs: 18, modelMs: 3560, firstTextMs: 1500, cleanupMs: 2 };
    for (const presentation of [{ state: "ready", response: { summary: "Done.", blocks: [] } }, { state: "error", message: "Timed out", retryable: true }]) {
      raw.body.messages[0].presentation = { ...presentation, timings };
      expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
      for (const invalid of [null, {}, { ...timings, totalMs: -1 }, { ...timings, totalMs: Number.MAX_SAFE_INTEGER + 1 }, { ...timings, queueMs: 0.5 }, { ...timings, startupMs: 4000 }, { ...timings, modelMs: null }, { ...timings, firstTextMs: 3561 }, { ...timings, cleanupMs: 3 }, { ...timings, cached: "yes" }, { ...timings, model: " " }]) {
        raw.body.messages[0].presentation = { ...presentation, timings: invalid };
        expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
      }
      raw.body.messages[0].presentation = { ...presentation, timings: { ...timings, cached: true, totalMs: 60000, queueMs: 60000, startupMs: null, modelMs: null, firstTextMs: null, cleanupMs: 0 } };
      expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    }
  });
  it("validates code snippet source and optional language without content caps", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const card = { type: "code", title: "Example", code: "const value = 42;", language: "typescript" };
    raw.body.messages[0].presentation = { state: "ready", response: { summary: "Example.", blocks: [card] } };
    for (const language of ["typescript", "not-installed", "", undefined]) {
      raw.body.messages[0].presentation.response.blocks = [{ ...card, language, code: "x".repeat(100_000) }];
      expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    }
    for (const code of ["", null, {}, [], 42]) {
      raw.body.messages[0].presentation.response.blocks = [{ ...card, code }];
      expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
    }
    raw.body.messages[0].presentation.response.blocks = [{ ...card, language: {} }];
    expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
  });
  it("accepts rectangular tables and rejects mismatched or empty cells", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const card = { type: "table", title: "Comparison", columns: ["Option", "Time"], rows: [["A", "2 s"], ["B", "3 s"]] };
    raw.body.messages[0].presentation = { state: "ready", response: { summary: "Results.", blocks: [card] } };
    expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    for (const count of [15, 32, 100]) {
      raw.body.messages[0].presentation.response.blocks = [{ ...card, rows: Array(count).fill(["Component", "Description"]) }];
      expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    }
    for (const rows of [[], [["A"]], [["A", "2 s", "extra"]], [["A", " "]]]) {
      raw.body.messages[0].presentation.response.blocks = [{ ...card, rows }];
      expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
    }
  });
  it("accepts many-column tables and rejects ragged rows", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const card = { type: "table", title: "Comparison", columns: ["Column"], rows: [["Value"]] };
    raw.body.messages[0].presentation = { state: "ready", response: { summary: "Results.", blocks: [card] } };
    for (const count of [5, 6, 20]) {
      card.columns = Array(count).fill("Column"); card.rows = [Array(count).fill("Value")];
      expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    }
    card.columns = Array(7).fill("Column"); card.rows = [Array(7).fill("Value")];
    expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    card.columns = Array(6).fill("Column"); card.rows = [Array(5).fill("Value")];
    expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
  });
  it("validates compact facts, before/after states and linear diagram labels", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const valid = [
      { type: "facts", title: "Key facts", items: [{ label: "Duration", value: "3.6 s" }] },
      { type: "comparison", title: "Change", before: "Long wait.", after: "Short wait." },
      { type: "flow", title: "Answer path", items: ["Pi", "Formatter", "Answer"] },
    ];
    for (const card of valid) {
      raw.body.messages[0].presentation = { state: "ready", response: { summary: "Done.", blocks: [card] } };
      expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    }
    const invalid = [
      { ...valid[0], items: [] }, { ...valid[0], items: [{ label: " ", value: "3.6 s" }] },
      { ...valid[1], before: " " }, { ...valid[2], items: ["Start", {}] },
    ];
    for (const card of invalid) {
      raw.body.messages[0].presentation.response.blocks = [card];
      expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
    }
  });
  it("accepts warning components and validates required text", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const card = { type: "warning", title: "Before deployment", text: "Back up the database." };
    raw.body.messages[0].presentation = { state: "ready", response: { summary: "Ready.", blocks: [card] } };
    expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    for (const text of [" ", null]) {
      raw.body.messages[0].presentation.response.blocks[0] = { ...card, text };
      expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
    }
  });
  it("accepts steps and rejects empty or non-text sequences", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const card = { type: "steps", title: "Get started", items: ["Save settings.", "Restart pi-web."] };
    raw.body.messages[0].presentation = { state: "ready", response: { summary: "Next steps.", blocks: [card] } };
    expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    for (const items of [[], [" "], [{ text: "Step" }]]) {
      raw.body.messages[0].presentation.response.blocks[0] = { ...card, items };
      expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
    }
  });
  it("validates source-reported check statuses and required text", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const card = { type: "checks", title: "Verification", items: ["passed", "failed", "skipped", "unverified"].map(status => ({ status, text: "Reported result." })) };
    raw.body.messages[0].presentation = { state: "ready", response: { summary: "Results.", blocks: [card] } };
    expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    for (const items of [[], [{ status: "success", text: "Done." }], [{ status: ["passed"], text: "Done." }], [{ status: "passed", text: " " }]]) {
      raw.body.messages[0].presentation.response.blocks[0] = { ...card, items };
      expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
    }
  });
  it("accepts optional details with required text", () => {
    const raw = JSON.parse(JSON.stringify(snapshot()));
    const card = { type: "details", title: "How it works", text: "Optional explanation." };
    raw.body.messages[0].presentation = { state: "ready", response: { summary: "Done.", blocks: [card] } };
    expect(() => decodeServer(JSON.stringify(raw))).not.toThrow();
    for (const blocks of [[{ ...card, text: " " }]]) {
      raw.body.messages[0].presentation.response.blocks = blocks;
      expect(() => decodeServer(JSON.stringify(raw))).toThrow("Invalid server message");
    }
  });
  it("accepts only app-owned work phases and keeps older status frames compatible", () => {
    const message = snapshot();
    if (message.body.type !== "snapshot") throw new Error("Expected snapshot");
    for (const workPhase of [undefined, "thinking", "writing", "reading", "editing", "searching", "executing", "researching", "checking", "delegating", "tools"]) {
      const value = { ...message, body: { ...message.body, status: { ...message.body.status, ...{ workPhase } } } };
      expect(() => decodeServer(JSON.stringify(value))).not.toThrow();
    }
    for (const workPhase of [null, 42, {}, ["reading"], "PRIVATE command", "<script>unsafe()</script>"]) {
      const value = { ...message, body: { ...message.body, status: { ...message.body.status, ...{ workPhase } } } };
      expect(() => decodeServer(JSON.stringify(value))).toThrow("Invalid server message");
    }
  });
  it("validates LSP status text and its UTF-8 byte limit", () => {
    const message = snapshot();
    if (message.body.type !== "snapshot") throw new Error("Expected snapshot");
    for (const lspStatus of [null, "", "LSP 1/2", "é".repeat(256)]) {
      const value = { ...message, body: { ...message.body, status: { ...message.body.status, lspStatus } } };
      expect(() => decodeServer(JSON.stringify(value))).not.toThrow();
    }
    for (const lspStatus of [42, {}, "é".repeat(257)]) {
      const value = { ...message, body: { ...message.body, status: { ...message.body.status, lspStatus } } };
      expect(() => decodeServer(JSON.stringify(value))).toThrow("Invalid server message");
    }
  });
  it("validates context measurements and rejects stale epochs", () => {
    const message = frame({ type: "context_usage", usage: { tokens: 12500, contextWindow: 100000 } });
    expect(decodeServer(JSON.stringify(message))).toEqual(message);
    const state = setup(); applyServer(state, message);
    expect(state.contextUsage).toEqual({ tokens: 12500, contextWindow: 100000 });
    expect(applyServer(state, frame({ type: "context_usage", usage: null }, "old"))).toBe("ignore");
    expect(state.contextUsage?.tokens).toBe(12500);
    for (const usage of [null, { tokens: null, contextWindow: 100000 }, { tokens: 0, contextWindow: 100000 }]) {
      expect(() => decodeServer(JSON.stringify({ ...message, body: { type: "context_usage", usage } }))).not.toThrow();
    }
    for (const usage of [{ tokens: -1, contextWindow: 100 }, { tokens: 1, contextWindow: 0 }, { tokens: 1.5, contextWindow: 100 }, { tokens: "1", contextWindow: 100 }, { tokens: Number.MAX_SAFE_INTEGER + 1, contextWindow: 100 }]) {
      expect(() => decodeServer(JSON.stringify({ ...message, body: { type: "context_usage", usage } }))).toThrow();
    }
    applyServer(state, frame({ type: "hello", project: "fixture", process: "ready" }));
    expect(state.contextUsage).toBeNull();
  });
  it("validates bounded command catalogs and resets them on reattachment", () => {
    const command = { name: "skill:testing", description: "Testing", source: "skill" as const };
    const message = frame({ type: "commands", commands: [command] });
    expect(decodeServer(JSON.stringify(message))).toEqual(message);
    const state = setup(); applyServer(state, message); expect(state.commands).toEqual([command]);
    applyServer(state, frame({ type: "hello", project: "fixture", process: "ready" }));
    expect(state.commands).toEqual([]);
    for (const commands of [
      Array.from({ length: 513 }, () => command),
      [{ ...command, name: "" }], [{ ...command, name: "/bad" }],
      [{ ...command, name: "bad name" }], [{ ...command, name: "bad\u0000name" }],
      [{ ...command, name: "a".repeat(257) }],
      [{ ...command, description: "a".repeat(1025) }],
      [{ ...command, description: 42 }], [{ ...command, source: "builtin" }],
    ]) expect(() => decodeServer(JSON.stringify({ ...message, body: { type: "commands", commands } }))).toThrow();
  });
  it("rejects retired tool patches and tool-call display blocks", () => {
    for (const patch of [
      { kind: "tool", tool: { id: "call", name: "read", arguments: "private", output: "private", state: "complete", truncated: false } },
      { kind: "remove_tool", id: "call" },
      { kind: "message", message: { id: "m", role: "assistant", blocks: [{ kind: "tool_call", text: "private" }], complete: true, error: null, truncated: false } },
    ]) {
      const message = { ...delta(2, ""), body: { ...delta(2, "").body, patches: [patch] } };
      expect(() => decodeServer(JSON.stringify(message))).toThrow("Invalid server message");
    }
  });
  it("enforces command catalog bounds in UTF-8 bytes", () => {
    const command = { name: "é".repeat(128), description: "😀".repeat(256), source: "prompt" as const };
    const message = frame({ type: "commands", commands: [command] });
    expect(decodeServer(JSON.stringify(message))).toEqual(message);
    for (const invalid of [{ ...command, name: `${command.name}a` }, { ...command, description: `${command.description}a` }]) {
      expect(() => decodeServer(JSON.stringify(frame({ type: "commands", commands: [invalid] })))).toThrow("Invalid server message");
    }
  });
  it("appends exactly once and demands a snapshot on a gap", () => {
    const state = setup(); applyServer(state, snapshot()); applyServer(state, delta(2, "!")); applyServer(state, delta(2, "!"));
    expect(state.messages.m.blocks[0].text).toBe("Hi!");
    expect(applyServer(state, delta(4, "bad"))).toBe("resync"); expect(state.messages.m.blocks[0].text).toBe("Hi!");
    applyServer(state, snapshot(5)); expect(state.synced).toBe(true); expect(state.messages.m.blocks[0].text).toBe("Hi");
  });
  it("rejects old epoch updates and snapshots after an explicit runtime replacement", () => {
    const state = setup(); applyServer(state, snapshot()); applyServer(state, frame({ type: "hello", project: "fixture", process: "starting" }, "e2")); applyServer(state, snapshot(0, "e2"));
    expect(applyServer(state, delta(2, "stale", "e1"))).toBe("ignore");
    expect(applyServer(state, snapshot(50, "e1"))).toBe("ignore"); expect(state.epoch).toBe("e2");
  });
  it("validates actual frame shapes, sparse indices and unsafe dictionary keys", () => {
    expect(decodeServer(JSON.stringify(snapshot()))).toEqual(snapshot());
    const sparse = delta(2, "x"); if (sparse.body.type === "event" && sparse.body.patches[0].kind === "delta") sparse.body.patches[0].index = 100000;
    for (const value of [null, {}, { ...snapshot(), v: 2 }, { ...snapshot(), body: { type: "event" } }, sparse]) {
      expect(() => decodeServer(JSON.stringify(value))).toThrow();
    }
    const polluted = snapshot(); if (polluted.body.type === "snapshot") polluted.body.messages[0].id = "__proto__";
    expect(() => decodeServer(JSON.stringify(polluted))).toThrow();
  });
});
