import { expect, it } from "vitest";
import { sanitizeArtifact } from "../src/html-artifact";
import fixtures from "./fixtures/artifact-images.json";

it.each(["png", "jpeg"] as const)("preserves an embedded %s image with accessible text but no active attributes", type => {
  const src = `data:image/${type};base64,${fixtures[type]}`;
  const element = document.createElement("div");
  element.innerHTML = sanitizeArtifact(`<img src="${src}" alt="A teal pixel" onerror="alert(1)" srcset="https://attacker.invalid/x 2x">`);
  const image = element.querySelector("img");
  expect(image?.getAttribute("src")).toBe(src);
  expect(image?.getAttribute("alt")).toBe("A teal pixel");
  expect(image?.hasAttribute("onerror")).toBe(false);
  expect(image?.hasAttribute("srcset")).toBe(false);
});

function image(source: string): HTMLImageElement | null {
  const element = document.createElement("div");
  element.innerHTML = sanitizeArtifact(`<img src="${source}" alt="Test">`);
  return element.querySelector("img");
}

function png(width: number, height: number, byteLength?: number): string {
  let data = Uint8Array.from(atob(fixtures.png), character => character.charCodeAt(0));
  const view = new DataView(data.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  // Container fixtures exercise header/budget checks, not final raster decoding.
  if (byteLength) {
    const padding = new Uint8Array(byteLength - data.length);
    new DataView(padding.buffer).setUint32(0, padding.length - 12);
    padding.set([116, 69, 88, 116], 4); // Ancillary tEXt chunk before IEND.
    const padded = new Uint8Array(byteLength);
    padded.set(data.subarray(0, -12)); padded.set(padding, data.length - 12); padded.set(data.subarray(-12), byteLength - 12);
    data = padded;
  }
  return `data:image/png;base64,${btoa(String.fromCharCode(...data))}`;
}

it.each([
  "https://attacker.invalid/image.png", "/auth", "blob:null/untrusted", "javascript:alert(1)",
  "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=",
  "data:text/html;base64,PGltZz4=", "data:image/gif;base64,R0lGODlh",
  "data:image/png;base64,not-base64!", "data:image/png;base64,PHN2Zz48L3N2Zz4=",
  `data:image/png;base64,${fixtures.jpeg}`, `data:image/jpeg;base64,${fixtures.png}`,
  `data:image/png;base64,${fixtures.png.slice(0, -4)}`, `data:image/jpeg;base64,${fixtures.jpeg.slice(0, -4)}`,
  `data:image/png;base64, ${fixtures.png}`, `data:image/png;base64,${fixtures.png}\n`,
])("rejects remote, active, spoofed or malformed image source %s", source => {
  expect(image(source)).toBeNull();
});

it("bounds individual dimensions, pixels and decoded byte counts", () => {
  expect(image(png(2048, 512))).not.toBeNull();
  for (const [width, height] of [[0, 1], [1, 0], [2049, 1], [1, 2049], [1025, 1024]]) {
    expect(image(png(width, height))).toBeNull();
  }
  expect(image(png(1, 1, 32_768))).not.toBeNull();
  expect(image(png(1, 1, 32_769))).toBeNull();
});

it("limits image count, aggregate bytes and aggregate decoded pixels per preview", () => {
  const count = (sources: string[]) => {
    const element = document.createElement("div");
    element.innerHTML = sanitizeArtifact(sources.map(src => `<img src="${src}">`).join(""));
    return element.querySelectorAll("img").length;
  };
  const tiny = `data:image/png;base64,${fixtures.png}`;
  expect(count(Array(9).fill(tiny))).toBe(8);
  expect(count([png(1, 1, 17_000), png(1, 1, 17_000)])).toBe(1);
  expect(count(Array(3).fill(png(1024, 1024)))).toBe(2);
});

it("rejects animated PNG containers and malformed JPEG segment lengths", () => {
  const animated = Uint8Array.from(atob(fixtures.png), character => character.charCodeAt(0));
  animated.set([97, 99, 84, 76], 37); // Treat the IDAT chunk as APNG's acTL.
  expect(image(`data:image/png;base64,${btoa(String.fromCharCode(...animated))}`)).toBeNull();
  const jpeg = Uint8Array.from(atob(fixtures.jpeg), character => character.charCodeAt(0));
  jpeg[4] = 255; jpeg[5] = 255;
  expect(image(`data:image/jpeg;base64,${btoa(String.fromCharCode(...jpeg))}`)).toBeNull();
});
