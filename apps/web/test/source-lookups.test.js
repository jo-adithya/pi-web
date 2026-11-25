import { expect, test, vi } from "vitest";
import { registerSourceTools } from "../../server/pi/source-lookups";

function fixture() {
  const long = "x".repeat(300) + "MATCH";
  const snapshot = { "queue.ts": "first\r\n" + long + "\r\n", "log.rs": "hit\n".repeat(20) };
  const tools = new Map();
  const disable = vi.fn();
  registerSourceTools({ registerTool: tool => tools.set(tool.name, tool), setActiveTools: disable }, snapshot);
  const call = async (name, args) => JSON.parse((await tools.get(name).execute("call", args)).content[0].text);
  return { call, tools, disable };
}

test("reads numbered lines and literal search matches only from the fixed snapshot", async () => {
  const { call, tools } = fixture();
  expect([...tools.keys()].sort()).toEqual(["read_source", "search_source"]);
  const result = await call("search_source", { query: "MATCH" });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ path: "queue.ts", line: 2 });
  expect(result.rows[0].text).toContain("MATCH");
  expect((await call("search_source", { query: "x.*MATCH" })).rows).toEqual([]);
  const read = await call("read_source", { path: "queue.ts", line: 1 });
  expect(read.rows).toHaveLength(2);
  expect(read.rows[0].text).toBe("first");
  expect(read.rows[1].text).toContain("[clipped]");
  await expect(call("read_source", { path: "../queue.ts", line: 1 })).rejects.toThrow(/not in/);
});

test("bounds reads, searches and failed lookups within one formatting job", async () => {
  const { call, disable } = fixture();
  expect((await call("search_source", { query: "hit" })).rows).toHaveLength(8);
  expect((await call("read_source", { path: "log.rs", line: 2 })).rows).toHaveLength(12);
  await expect(call("read_source", { path: "log.rs", line: 0 })).rejects.toThrow();
  await expect(call("search_source", { query: "" })).rejects.toThrow();
  expect(disable).toHaveBeenCalledWith([]);
  await expect(call("read_source", { path: "log.rs", line: 1 })).rejects.toThrow(/budget/);
});
