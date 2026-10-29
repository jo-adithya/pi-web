import { describe, expect, it } from "vitest";
import { applyServer, decodeServer, initialState } from "../src/client-state";
import type { ServerMessage, ServerBody } from "../src/generated/protocol";
const frame = (body: ServerBody, epoch = "e1"): ServerMessage => ({ v: 1, sessionId: "app", epoch, body });
function setup() { const state = initialState(); applyServer(state, frame({ type: "hello", project: "fixture", process: "ready" })); return state; }
const snapshot = (seq = 1, epoch = "e1") => frame({ type: "snapshot", throughSeq: seq, status: initialState().status, messages: [{ id: "m", role: "assistant", blocks: [{ kind: "text", text: "Hi" }], complete: false, error: null, truncated: false }], dialogs: [], olderHistory: false }, epoch);
const delta = (seq: number, text: string, epoch = "e1") => frame({ type: "event", seq, patches: [{ kind: "delta", id: "m", index: 0, thinking: false, text, truncated: false }], status: initialState().status, dialogs: [], olderHistory: false }, epoch);

describe("snapshot and delta consistency", () => {
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
