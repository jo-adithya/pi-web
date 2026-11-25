import { expect, it, vi } from "vitest";
import register, { NOTE_PREFIX, type NoteHost } from "../../server/pi/review-notes";

function fixture() {
  const tools = new Map<string, Parameters<NoteHost["registerTool"]>[0]>();
  const events = new Map<string, (event: { prompt: string }) => void>();
  let active = ["read", "edit"];
  const host = {
    registerTool: (tool: Parameters<NoteHost["registerTool"]>[0]) => { tools.set(tool.name, tool); },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    on: (name: string, handler: (event: { prompt: string }) => void) => { events.set(name, handler); },
  } as NoteHost;
  register(host);
  const input = vi.fn(async (_title: string, _placeholder?: string, _options?: unknown): Promise<string | undefined> => JSON.stringify({ data: { id: "retry", version: 1 } }));
  const execute = (name: string, args = {}, mode = "rpc", signal?: AbortSignal) => tools.get(name)!.execute("call", args, signal, undefined, { mode, ui: { input } });
  const start = (prompt: string) => events.get("before_agent_start")!({ prompt });
  const close = (event = "agent_settled") => events.get(event)!({ prompt: "" });
  return { tools, host, input, execute, start, close };
}
it("exposes tools only in an opted-in turn, preserves other tools and closes on settlement", async () => {
  const f = fixture();
  expect([...f.tools.values()].every(tool => tool.defaultActive === false)).toBe(true);
  f.start("ordinary prompt"); expect(f.host.getActiveTools()).toEqual(["read", "edit"]);
  await expect(f.execute("list_review_notes")).rejects.toThrow(/active opted-in/);
  f.start("Implement\n[Pi Web review notes turn epoch:1]");
  expect(f.host.getActiveTools()).toEqual(["read", "edit", "record_review_note", "list_review_notes", "delete_review_note"]);
  f.start("queued continuation"); await f.execute("list_review_notes");
  f.close(); expect(f.host.getActiveTools()).toEqual(["read", "edit"]);
  await expect(f.execute("list_review_notes")).rejects.toThrow();
});
it("uses the private correlated RPC channel and returns a short receipt without source patches", async () => {
  const f = fixture(); f.start("Implement\n[Pi Web review notes turn epoch:2]");
  const args = { id: "retry", note: { path: "a.ts", side: "new", line: 2, quote: "new", text: "Keep retries." } };
  const result = await f.execute("record_review_note", args);
  expect(JSON.parse(f.input.mock.calls[0][0]!.slice(NOTE_PREFIX.length))).toEqual({ turn: "epoch:2", operation: { ...args, action: "record" } });
  expect(result.content[0].text).toBe('{"id":"retry","version":1}');
  expect(result.details).toBeUndefined();
  expect(f.tools.get("list_review_notes")!.annotations.readOnlyHint).toBe(true);
  expect(f.tools.get("delete_review_note")!.annotations.destructiveHint).toBe(true);
});
it("fails closed on non-RPC use, cancellation, backend rejection and missing replies", async () => {
  const f = fixture(); f.start("Implement\n[Pi Web review notes turn epoch:1]");
  await expect(f.execute("list_review_notes", {}, "tui")).rejects.toThrow();
  const cancelled = new AbortController(); cancelled.abort();
  await expect(f.execute("list_review_notes", {}, "rpc", cancelled.signal)).rejects.toThrow();
  expect(f.input).not.toHaveBeenCalled();
  f.input.mockResolvedValueOnce(JSON.stringify({ error: "Note version changed" }));
  await expect(f.execute("delete_review_note", { id: "retry", version: 1 })).rejects.toThrow(/version changed/);
  f.input.mockResolvedValueOnce(undefined);
  await expect(f.execute("record_review_note")).rejects.toThrow(/may have applied/);
  f.close("session_shutdown"); await expect(f.execute("list_review_notes")).rejects.toThrow();
});
