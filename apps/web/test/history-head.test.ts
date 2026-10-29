import { expect, test, vi } from "vitest";
import registerHistoryHead, {
  type HistoryHeadContext,
  type HistoryHeadHost,
} from "../../server/pi/history-head";
import fixture from "../../../fixtures/protocol/history-head.json";

/** Captures the public command using only the read-only APIs supplied by Pi. */
function setup() {
  let handler: Parameters<HistoryHeadHost["registerCommand"]>[1]["handler"] | undefined;
  registerHistoryHead({ registerCommand(name, command) {
    expect(name).toBe("pi-web-history-head");
    handler = command.handler;
  } });
  const notify = vi.fn();
  const context: HistoryHeadContext = {
    mode: "rpc",
    sessionManager: {
      getSessionId: () => fixture.head.sessionId,
      getSessionFile: () => fixture.head.sessionFile,
      getLeafId: () => fixture.head.leafId,
    },
    isIdle: () => true,
    ui: { notify },
  };
  if (!handler) throw new Error("history-head command was not registered");
  return { handler, context, notify };
}

/** Decodes the single private notification emitted by an invocation. */
function reply(notify: ReturnType<typeof setup>["notify"]) {
  expect(notify).toHaveBeenCalledTimes(1);
  const message: string = notify.mock.calls[0][0];
  expect(message.startsWith("pi-web:history-head:v1:")).toBe(true);
  expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(8192);
  return JSON.parse(message.slice("pi-web:history-head:v1:".length));
}

test.each(["", "bad token", "x".repeat(65), "../secret", "a\n"])(
  "rejects invalid correlation token %j without reading session state", async (token) => {
    const { handler, context, notify } = setup();
    const read = vi.fn(() => { throw new Error("must not read metadata"); });
    context.sessionManager.getSessionId = read;
    await handler(token, context);
    expect(reply(notify)).toEqual({ status: "error", requestId: null, code: "invalid_request" });
    expect(read).not.toHaveBeenCalled();
  },
);

test.each(["getSessionId", "getLeafId", "getSessionFile"] as const)(
  "rejects oversized %s with a bounded error", async (key) => {
    const { handler, context, notify } = setup();
    context.sessionManager[key] = () => "x".repeat(key === "getSessionFile" ? 4097 : 1025);
    await handler("head-1", context);
    expect(reply(notify)).toEqual({ status: "error", requestId: "head-1", code: "metadata_limit" });
  },
);

test("enforces UTF-8 byte limits and accepts the exact boundary", async () => {
  const { handler, context, notify } = setup();
  context.sessionManager.getLeafId = () => "é".repeat(512);
  context.sessionManager.getSessionFile = () => "/" + "a".repeat(4095);
  await handler("x".repeat(64), context);
  expect(reply(notify).status).toBe("ok");
  notify.mockClear();
  context.sessionManager.getLeafId = () => "é".repeat(513);
  await handler("head-1", context);
  expect(reply(notify).code).toBe("metadata_limit");
});

test("bounds JSON escaping overhead independently of metadata byte length", async () => {
  const { handler, context, notify } = setup();
  context.sessionManager.getSessionFile = () => "\u0001".repeat(4096);
  await handler("head-1", context);
  expect(reply(notify).code).toBe("metadata_limit");
});

test("reports missing persistence, empty leaf and active state explicitly", async () => {
  const { handler, context, notify } = setup();
  context.sessionManager.getSessionFile = () => undefined;
  context.sessionManager.getLeafId = () => null;
  context.isIdle = () => false;
  await handler("head-1", context);
  expect(reply(notify).head).toEqual({
    sessionId: fixture.head.sessionId, sessionFile: null, leafId: null, idle: false,
  });
});

test("sanitizes metadata failures", async () => {
  const { handler, context, notify } = setup();
  context.sessionManager.getLeafId = () => { throw new Error("PRIVATE_ERROR"); };
  await handler("head-1", context);
  expect(reply(notify)).toEqual({ status: "error", requestId: "head-1", code: "metadata_unavailable" });
  expect(notify.mock.calls[0][0]).not.toContain("PRIVATE_ERROR");
});

test("rejects non-RPC execution without exposing paths in a notification", async () => {
  const { handler, context, notify } = setup();
  context.mode = "tui";
  await expect(handler("head-1", context)).rejects.toThrow("requires RPC mode");
  expect(notify).not.toHaveBeenCalled();
});

test("reports correlated current session metadata without reading the transcript", async () => {
  const { handler, context, notify } = setup();
  await handler("head-1", context);
  expect(notify.mock.calls).toEqual([
    ["pi-web:history-head:v1:" + JSON.stringify(fixture), "info"],
  ]);
});
