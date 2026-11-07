import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import fixtures from "./fixtures/artifact-images.json";

function viewer() {
  const document = globalThis.document.implementation.createHTMLDocument();
  const parent = { postMessage: vi.fn() };
  const events = { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const html = readFileSync("../server/src/artifact-preview.html", "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  new Function("window", "document", "parent", script)(events, document, parent);
  const receive = events.addEventListener.mock.calls[0][1] as (event: { source: object; data: unknown }) => void;
  return { document, send: (data: unknown, source: object = parent) => receive({ data, source }) };
}

it.each(["png", "jpeg"] as const)("materializes an accepted parent %s image as a local blob before insertion", type => {
  const createObjectURL = vi.fn((_blob: Blob) => "blob:null/artifact-image");
  vi.stubGlobal("URL", { createObjectURL });
  try {
    const { document, send } = viewer();
    const html = `<img src="data:image/${type};base64,${fixtures[type]}" alt="Teal pixel">`;
    send({ type: "pi-web-artifact", html }, {});
    expect(createObjectURL).not.toHaveBeenCalled();
    send({ type: "pi-web-artifact", html });
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe(`image/${type}`);
    expect(blob.size).toBe(atob(fixtures[type]).length);
    expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:null/artifact-image");
    expect(document.querySelector("img")?.getAttribute("alt")).toBe("Teal pixel");
    send({ type: "pi-web-artifact", html });
    expect(createObjectURL).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

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

it("supplies radius as an opt-in token across themes", () => {
  const { document, send } = viewer();
  send({ type: "pi-web-artifact", html: '<div id="plain">Square by default</div>', theme: { dark: false, colors: { radius: "0.625rem" } } });
  expect(document.documentElement.style.getPropertyValue("--radius")).toBe("0.625rem");
  expect(document.getElementById("plain")?.style.borderRadius).toBe("");
  send({ type: "pi-web-artifact-theme", dark: true, colors: { radius: "0.75rem" } });
  expect(document.documentElement.style.getPropertyValue("--radius")).toBe("0.75rem");
  send({ type: "pi-web-artifact-theme", dark: true, colors: { radius: "9rem" } }, {});
  expect(document.documentElement.style.getPropertyValue("--radius")).toBe("0.75rem");
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
