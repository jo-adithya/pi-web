// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("authorizes exactly the shipped viewer bootstrap in the server's CSP", () => {
  const viewer = readFileSync(new URL("../../server/src/artifact-preview.html", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../server/src/http.rs", import.meta.url), "utf8");
  const scripts = [...viewer.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const hash = createHash("sha256").update(scripts[0][1]).digest("base64");
  // A bootstrap edit without the corresponding CSP change would silently break every preview.
  expect(server).toContain(`script-src 'sha256-${hash}';`);
});
