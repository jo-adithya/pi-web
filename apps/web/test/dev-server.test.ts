import { describe, expect, it } from "vitest";
import { developmentServer } from "../dev-server";

describe("private Tailscale development server", () => {
  it("binds locally and proxies without rewriting the browser's authentication boundary", () => {
    const server = developmentServer({ PI_WEB_DEV_ORIGIN: "https://machine.tailnet.ts.net" });
    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBe(5173);
    expect(server.strictPort).toBe(true);
    expect(server.allowedHosts).toEqual(["machine.tailnet.ts.net"]);
    expect(server.cors).toBe(false);
    expect(server.hmr).toMatchObject({ protocol: "wss", host: "machine.tailnet.ts.net", clientPort: 443, path: "/__pi_web_hmr" });
    const proxy = server.proxy!;
    for (const path of ["/auth", "/ws", "/push", "/sw.js"]) {
      const match = Object.entries(proxy).find(([pattern]) => new RegExp(pattern.slice(1)).test(path));
      expect(match, path).toBeDefined();
      expect(match![1]).toMatchObject({ target: "http://127.0.0.1:9876", changeOrigin: false });
    }
    expect(Object.keys(proxy).some(pattern => new RegExp(pattern.slice(1)).test("/__pi_web_hmr"))).toBe(false);
  });
  it("requires an exact HTTPS origin and a valid backend port", () => {
    for (const origin of [undefined, "http://machine.ts.net", "https://machine.ts.net/", "https://machine.ts.net/path", "https://user@machine.ts.net", "https://machine.ts.net:444", "https://machine.ts.net?x", "https://MACHINE.ts.net"]) {
      expect(() => developmentServer({ PI_WEB_DEV_ORIGIN: origin })).toThrow();
    }
    for (const port of ["0", "65536", "9876/path", "-1", "1.5"]) {
      expect(() => developmentServer({ PI_WEB_DEV_ORIGIN: "https://machine.ts.net", PI_WEB_BACKEND_PORT: port })).toThrow();
    }
    expect(developmentServer({ PI_WEB_DEV_ORIGIN: "https://machine.ts.net", PI_WEB_BACKEND_PORT: "9877" }).proxy).toHaveProperty("^/ws(?:\\?|$)", expect.objectContaining({ target: "http://127.0.0.1:9877", ws: true }));
  });
});
