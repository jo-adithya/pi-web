import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

function viewer() {
  const document = globalThis.document.implementation.createHTMLDocument();
  const parent = {};
  const events = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const html = readFileSync("../server/src/artifact-preview.html", "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  new Function("window", "document", "parent", script)(events, document, parent);
  const receive = events.addEventListener.mock.calls[0][1] as (event: { source: object; data: unknown }) => void;
  return { document, send: (data: unknown, source = parent) => receive({ data, source }) };
}

it("applies parent theme colors live without replacing an existing visual", () => {
  const { document, send } = viewer();
  send({ type: "pi-web-artifact", html: '<div id="visual">Keep this visual</div>' });
  const visual = document.getElementById("visual");
  send({ type: "pi-web-artifact-theme", dark: true, colors: { background: "#171c22", foreground: "#f5f5f5" } });
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(document.documentElement.style.getPropertyValue("--background")).toBe("#171c22");
  send({ type: "pi-web-artifact-theme", dark: false, colors: { background: "#ffffff" } });
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(document.documentElement.style.colorScheme).toBe("light");
  expect(document.documentElement.style.getPropertyValue("--background")).toBe("#ffffff");
  expect(document.getElementById("visual")).toBe(visual);
  send({ type: "pi-web-artifact", html: "Replacement" });
  expect(document.getElementById("visual")).toBe(visual);
});

it("ignores foreign messages and invalid themes, and accepts only bounded palette entries", () => {
  const { document, send } = viewer();
  send({ type: "pi-web-artifact-theme", dark: true, colors: { background: "red" } }, {});
  send({ type: "pi-web-artifact-theme", dark: "dark", colors: { background: "red" } });
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  send({ type: "pi-web-artifact-theme", dark: true, colors: { background: "x".repeat(257), foreground: 42, arbitrary: "red", border: "#cccccc" } });
  expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--foreground")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--arbitrary")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--border")).toBe("#cccccc");
});
