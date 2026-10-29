// @vitest-environment node
import { createServer as createHttpServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import { expect, it } from "vitest";
import { developmentServer } from "../dev-server";

it("Vite preserves HTTP and socket proofs and keeps its HMR connection separate", async () => {
  const seen: { host?: string; origin?: string; proof?: string; path?: string }[] = [];
  const backend = createHttpServer((req, res) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin, path: req.url });
    res.end("backend");
  });
  backend.on("upgrade", (req, socket) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin, proof: req.headers["sec-websocket-protocol"] as string, path: req.url });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const origin = "https://machine.tailnet.ts.net";
  const server = await createServer({
    configFile: false,
    server: { ...developmentServer({ PI_WEB_DEV_ORIGIN: origin, PI_WEB_BACKEND_PORT: String((backend.address() as AddressInfo).port) }), port: 0 },
  });
  try {
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const send = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host: "machine.tailnet.ts.net", origin, ...headers } }, res => {
        let body = "";
        res.setEncoding("utf8").on("data", chunk => body += chunk);
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
      req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode!, body: "" }); });
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("proxy test timeout")));
      req.end();
    });
    for (const path of ["/auth", "/push", "/sw.js"]) {
      expect(await send(path)).toEqual({ status: 200, body: "backend" });
      expect(seen.at(-1)).toEqual({ host: "machine.tailnet.ts.net", origin, path });
    }
    // Invalid origins must reach Rust unchanged, never be rewritten into trusted ones.
    await send("/auth", { origin: "https://untrusted.example" });
    expect(seen.at(-1)?.origin).toBe("https://untrusted.example");
    const proof = "pi-web.v1, pi-web.cap.synthetic-test-proof";
    expect((await send("/ws", { connection: "Upgrade", upgrade: "websocket", "sec-websocket-protocol": proof })).status).toBe(101);
    expect(seen.at(-1)).toEqual({ host: "machine.tailnet.ts.net", origin, proof, path: "/ws" });
    const count = seen.length;
    const client = await send("/@vite/client");
    expect(client.status).toBe(200);
    expect(client.body).toContain("/__pi_web_hmr");
    expect(seen).toHaveLength(count);
    expect((await send("/", { host: "untrusted.example" })).status).toBe(403);
  } finally {
    await server.close();
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
  }
}, 15000);
