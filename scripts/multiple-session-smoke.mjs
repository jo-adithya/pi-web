#!/usr/bin/env bun
/** Local opt-in HTTP/WebSocket integration. Uses only the deterministic RPC fixture, never a provider. */
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const argument = process.argv.indexOf("--server");
if (!process.argv.includes("--run") || argument < 0 || !process.argv[argument + 1]) throw new Error("usage: bun scripts/multiple-session-smoke.mjs --run --server /absolute/pi-web");
const server = resolve(process.argv[argument + 1]);
const root = await mkdtemp(join(tmpdir(), "pi-web-ws-smoke-"));
let child, socket; let failed;
async function wait(predicate, label, milliseconds = 15000) {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) { if (failed) throw failed; if (performance.now() >= deadline) throw new Error(`deadline: ${label}`); await Bun.sleep(10); }
}
try {
  const fixture = join(root, "pi"); await writeFile(fixture, await readFile(new URL("../apps/server/tests/fixtures/runtime_mock.py", import.meta.url))); await chmod(fixture, 0o700);
  child = Bun.spawn([server, "--cwd", root, "--state-dir", join(root, "state"), "--pi", fixture, "--isolated", "--port", "0"], { stdout: "pipe", stderr: "pipe" });
  let output = ""; const drain = async stream => { for await (const chunk of stream) { output += new TextDecoder().decode(chunk); if (output.length > 65536) throw new Error("server output limit"); } };
  const drains = Promise.all([drain(child.stdout), drain(child.stderr)]).catch(error => { failed = error; });
  await wait(() => /http:\/\/127\.0\.0\.1:\d+\/#cap=\S+/.test(output), "server startup");
  const url = new URL(output.match(/http:\/\/127\.0\.0\.1:\d+\/#cap=\S+/)[0]);
  const capability = new URLSearchParams(url.hash.slice(1)).get("cap");
  const response = await fetch(`${url.origin}/auth`, { method: "POST", headers: { Origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ capability }) });
  assert.equal(response.status, 204); assert.equal(response.headers.get("set-cookie"), null);
  const replay = await fetch(`${url.origin}/ws`, { headers: { Origin: url.origin, Cookie: `pi_web_${url.port}=${capability}` } });
  assert.equal(replay.status, 401, "ambient cookie replay must not grant socket authority");
  const replies = new Map(), states = new Map(), epochs = new Map(), sequences = new Map(), events = new Map(); let catalog;
  const open = async () => {
    const ws = new WebSocket(`ws://${url.host}/ws`, { protocols: ["pi-web.v1", `pi-web.cap.${capability}`], headers: { Origin: url.origin } });
    ws.addEventListener("message", event => {
      try {
        assert.ok(event.data.length <= 16 * 1024 * 1024); const message = JSON.parse(event.data);
        if (message.v === 2) { catalog = message; if (message.requestId) replies.set(message.requestId, message); }
        else {
          const id = message.sessionId, body = message.body;
          if (body.type === "hello") { epochs.set(id, message.epoch); sequences.delete(id); }
          if (body.type === "snapshot") { sequences.set(id, body.throughSeq); states.set(id, body.status); }
          if (body.type === "event") { assert.equal(message.epoch, epochs.get(id)); assert.equal(body.seq, sequences.get(id) + 1); sequences.set(id, body.seq); states.set(id, body.status); events.set(id, (events.get(id) || 0) + 1); }
          if (body.type === "result") replies.set(body.result.requestId, body.result);
        }
        assert.ok(replies.size <= 128, "test observation limit");
      } catch (error) { failed = error; ws.close(); }
    });
    await wait(() => ws.readyState === WebSocket.OPEN, "socket open");
    assert.equal(ws.protocol, "pi-web.v1", "the server must not echo the credential-bearing offer");
    return ws;
  };
  socket = await open(); await wait(() => catalog, "initial catalog");
  const request = async (action, sessionId) => {
    const requestId = crypto.randomUUID(); socket.send(JSON.stringify(sessionId ? { v: 1, sessionId, epoch: epochs.get(sessionId), requestId, action } : { v: 2, requestId, action }));
    await wait(() => replies.has(requestId), `${action.type} result`); const reply = replies.get(requestId); replies.delete(requestId); assert.ok(reply.ok, JSON.stringify(reply)); return reply;
  };
  const a = catalog.selected; await request({ type: "subscribe", sessionId: a });
  const b = (await request({ type: "create" })).target; await request({ type: "subscribe", sessionId: b });
  await wait(() => [a, b].every(id => states.get(id)?.process === "ready" && states.get(id)?.activity === "idle"), "both ready");
  await request({ type: "prompt", text: "retry" }, a); await request({ type: "prompt", text: "retry" }, b);
  await wait(() => [a, b].every(id => states.get(id)?.activity === "retrying"), "both active");
  await request({ type: "cancel" }, a); assert.notEqual(states.get(b)?.activity, "idle"); await request({ type: "cancel" }, b);
  await wait(() => [a, b].every(id => states.get(id)?.activity === "idle"), "both settled");
  const before = events.get(a) || 0; await request({ type: "prompt", text: "benchmark" }, a);
  await wait(() => (events.get(a) || 0) > before, "noisy session events");
  const started = performance.now(); await request({ type: "prompt", text: "/handled" }, b); const otherLatency = performance.now() - started; assert.ok(otherLatency < 2000, "noisy A starved B");
  socket.close(); await wait(() => socket.readyState === WebSocket.CLOSED, "detach");
  await Bun.sleep(100); socket = await open(); await request({ type: "subscribe", sessionId: a }); await request({ type: "subscribe", sessionId: b });
  await wait(() => states.get(a)?.lastOutcome === "success", "generation survives reconnect", 15000);
  const oldEpoch = epochs.get(b); await request({ type: "stop", sessionId: b, epoch: oldEpoch, confirmed: true });
  await request({ type: "open", sessionId: b }); await request({ type: "subscribe", sessionId: b });
  await wait(() => epochs.get(b) !== oldEpoch && states.get(b)?.process === "ready", "fresh epoch");
  // Pipelined socket-local effects must finish in wire order, even with asynchronous manager jobs.
  for (let iteration = 0; iteration < 4; iteration++) {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, type] of ["unsubscribe", "subscribe"].entries()) socket.send(JSON.stringify({ v: 2, requestId: ids[index], action: { type, sessionId: b } }));
    await wait(() => ids.every(id => replies.has(id)), "ordered subscriptions");
    for (const id of ids) { assert.ok(replies.get(id).ok); replies.delete(id); }
    await request({ type: "attach" }, b);
  }
  console.log(JSON.stringify({ passed: true, explicitSocketProof: true, cookieReplayRejected: true, orderedSubscriptionPairs: 4, providerRequests: 0, sessions: 2, independentCancel: true, sequenceGaps: 0, noisySessionOtherCommandMilliseconds: Math.round(otherLatency), reconnectPreservedGeneration: true, stopReopenChangedEpoch: true }));
  socket.close(); child.kill("SIGTERM");
  assert.equal(await Promise.race([child.exited, Bun.sleep(20000).then(() => { throw new Error("server cleanup deadline"); })]), 0);
  await drains;
} finally {
  socket?.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(20000).then(() => { throw new Error(`cleanup deadline; retained fixture at ${root}`); })]);
  }
  await rm(root, { recursive: true, force: true });
}
