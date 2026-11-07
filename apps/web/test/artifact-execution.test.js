// @vitest-environment node
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { sanitizeArtifact } from "../src/html-artifact";

const viewer = readFileSync(new URL("../../server/src/artifact-preview.html", import.meta.url), "utf8");

it("executes sanitized classic scripts once in document order with working controls and initial/live theme", () => {
  const dom = new JSDOM(viewer, { runScripts: "dangerously" });
  vi.stubGlobal("document", dom.window.document);
  const html = sanitizeArtifact(`<button id="run" onclick="throw 1">Run</button><output id="result"></output><script>
    window.runs = [document.documentElement.style.getPropertyValue('--primary')];
    document.querySelector('#run').addEventListener('click', () => document.querySelector('#result').textContent = 'clicked');
    window.addEventListener('pi-web-theme-change', () => runs.push('theme'));
  </script><script>runs.push('second')</script>`);
  const send = (data, source = dom.window.parent) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source }));
  const data = { type: "pi-web-artifact", html, theme: { dark: true, colors: { primary: "red" } } };
  send(data, {});
  expect(dom.window.document.querySelector('#run')).toBeNull();
  send(data);
  expect(dom.window.runs).toEqual(["red", "second"]);
  dom.window.document.querySelector('#run').click();
  expect(dom.window.document.querySelector('#result').textContent).toBe('clicked');
  send(data);
  expect(dom.window.runs).toEqual(["red", "second"]);
  send({ type: "pi-web-artifact-theme", dark: false, colors: { primary: "blue" } });
  expect(dom.window.runs).toEqual(["red", "second", "theme"]);
  dom.window.close();
  vi.unstubAllGlobals();
});

it("loads the explicit Chart marker as raw text and executes the bundle only in the viewer", async () => {
  const { artifactChartJs } = await import("../src/artifact-library");
  const dom = new JSDOM(viewer, { runScripts: "dangerously" });
  vi.stubGlobal("document", dom.window.document);
  expect(await artifactChartJs(sanitizeArtifact('<p data-library="chart.js">No library</p>'))).toBeUndefined();
  const html = sanitizeArtifact('<canvas id="chart"></canvas><script data-library="chart.js"></script><script>document.querySelector("canvas").dataset.version = Chart.version</script>');
  const chartJs = await artifactChartJs(html);
  expect(chartJs).toContain('Chart.js v4.6.1');
  expect(dom.window.Chart).toBeUndefined();
  expect(Reflect.get(globalThis, "Chart")).toBeUndefined();
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: dom.window.parent, data: { type: "pi-web-artifact", html, chartJs } }));
  expect(dom.window.document.querySelector('canvas').dataset.version).toBe('4.6.1');
  expect(Reflect.get(globalThis, "Chart")).toBeUndefined();
  dom.window.close();
  vi.unstubAllGlobals();
});

it("strips external/module scripts and handlers while retaining demo controls and safe data attributes", () => {
  const dom = new JSDOM();
  vi.stubGlobal("document", dom.window.document);
  const html = sanitizeArtifact(`<script src="/evil">evil()</script><script type="module">evil()</script><script type="importmap">{}</script><script>safe()</script><label for="n">N</label><input id="n" type="range" min="0" max="10" step="1" value="3" oninput="evil()"><select><option selected value="a">A</option></select><textarea rows="2" data-demo="ok">Hello</textarea><output></output>`);
  const template = dom.window.document.createElement('template');
  template.innerHTML = html;
  expect([...template.content.querySelectorAll('script')].map(s => s.textContent)).toEqual(['safe()']);
  expect(template.content.querySelector('[oninput]')).toBeNull();
  expect(template.content.querySelector('input').max).toBe('10');
  expect(template.content.querySelector('option').selected).toBe(true);
  expect(template.content.querySelector('textarea').dataset.demo).toBe('ok');
  dom.window.close();
  vi.unstubAllGlobals();
});

it("reports intrinsic body size after replacement, deduplicates changes and releases observation", () => {
  let resize;
  const observe = vi.fn(), disconnect = vi.fn();
  const dom = new JSDOM(viewer, { runScripts: "dangerously", beforeParse(window) {
    window.ResizeObserver = class {
      constructor(callback) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    };
  } });
  const { window } = dom;
  const send = vi.spyOn(window.parent, "postMessage");
  let height = 180;
  vi.spyOn(window.document.body, "getBoundingClientRect").mockImplementation(() => ({ height }));
  // Browsers can floor body scrollHeight at the viewport: it must not prevent shrinkage.
  let scrollHeight = 600;
  Object.defineProperty(window.document.body, "scrollHeight", { get: () => scrollHeight });
  Object.defineProperty(window.document.documentElement, "clientHeight", { get: () => 600 });
  window.dispatchEvent(new window.MessageEvent("message", { source: window.parent, data: { type: "pi-web-artifact", html: "<p>Content</p>" } }));
  expect(send).toHaveBeenLastCalledWith({ type: "pi-web-artifact-size", height: 180 }, "*");
  expect(observe).toHaveBeenCalledWith(window.document.body);
  resize(); expect(send).toHaveBeenCalledTimes(1);
  height = 95; resize();
  expect(send).toHaveBeenLastCalledWith({ type: "pi-web-artifact-size", height: 95 }, "*");
  scrollHeight = 900; resize();
  expect(send).toHaveBeenLastCalledWith({ type: "pi-web-artifact-size", height: 900 }, "*");
  scrollHeight = 600;
  height = 25000; resize();
  expect(send).toHaveBeenLastCalledWith({ type: "pi-web-artifact-size", height: 20000 }, "*");
  height = 0; resize();
  expect(send).toHaveBeenLastCalledWith({ type: "pi-web-artifact-size", height: 80 }, "*");
  window.dispatchEvent(new window.Event("pagehide"));
  expect(disconnect).toHaveBeenCalledOnce();
  dom.window.close();
});
