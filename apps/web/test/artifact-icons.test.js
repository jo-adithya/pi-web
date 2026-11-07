// @vitest-environment node
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { sanitizeArtifact } from "../src/html-artifact";

const viewer = readFileSync(new URL("../../server/src/artifact-preview.html", import.meta.url), "utf8");
let dom;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});

function render(html) {
  dom = new JSDOM(viewer, { runScripts: "dangerously" });
  vi.stubGlobal("document", dom.window.document);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    source: dom.window.parent,
    data: { type: "pi-web-artifact", html: sanitizeArtifact(html) },
  }));
  return dom.window.document;
}

it("prepends a decorative outline SVG while retaining wrapper labels and styling", () => {
  const document = render('<span id="next" data-icon="arrow-right" class="step" style="color: red; font-size: 24px" role="img" aria-label="Next step"> Next <b>step</b></span>');
  const wrapper = document.querySelector('#next');
  const svg = wrapper.querySelector('svg');
  expect(svg).not.toBeNull();
  expect(wrapper.firstChild).toBe(svg);
  expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  expect(svg.getAttribute('width')).toBe('1em');
  expect(svg.getAttribute('height')).toBe('1em');
  expect(svg.getAttribute('fill')).toBe('none');
  expect(svg.getAttribute('stroke')).toBe('currentColor');
  expect(svg.getAttribute('stroke-width')).toBe('2');
  expect(svg.getAttribute('stroke-linecap')).toBe('round');
  expect(svg.getAttribute('stroke-linejoin')).toBe('round');
  expect(svg.getAttribute('aria-hidden')).toBe('true');
  expect(svg.getAttribute('focusable')).toBe('false');
  expect(svg.querySelector('path').namespaceURI).toBe(svg.namespaceURI);
  expect(svg.querySelector('path').getAttribute('d')).toBe('M4 12h16m-7-7 7 7-7 7');
  expect(wrapper.textContent).toBe(' Next step');
  expect(wrapper.querySelector('b').textContent).toBe('step');
  expect(wrapper.getAttribute('aria-label')).toBe('Next step');
  expect(wrapper.getAttribute('role')).toBe('img');
  expect(wrapper.className).toBe('step');
  expect(wrapper.style.color).toBe('red');
  expect(wrapper.style.fontSize).toBe('24px');
});

it("leaves unknown, prototype and non-span markers untouched", () => {
  const names = ['missing', '__proto__', 'constructor', 'toString', 'hasOwnProperty', ''];
  const document = render(names.map(name => `<span data-icon="${name}"><b>Fallback</b></span>`).join('') + '<div data-icon="check">Not a span</div>');
  expect(document.querySelector('svg')).toBeNull();
  for (const marker of document.querySelectorAll('span')) {
    expect(marker.innerHTML).toBe('<b>Fallback</b>');
  }
  expect(document.querySelector('div').innerHTML).toBe('Not a span');
});

it("materializes every supported icon before scripts, only on initial render", async () => {
  const names = ['arrow-right', 'arrow-left', 'check', 'x', 'info', 'warning', 'code', 'search', 'settings', 'file', 'folder', 'clock', 'plus', 'minus'];
  const document = render(names.map(name => `<span data-icon="${name}"></span>`).join('') + `<script>
    window.initialIcons = document.querySelectorAll('span > svg').length;
    const late = document.createElement('span');
    late.id = 'late';
    late.dataset.icon = 'check';
    late.textContent = 'Added later';
    document.body.append(late);
  </script>`);
  expect(dom.window.initialIcons).toBe(names.length);
  const paths = [...document.querySelectorAll('span > svg > path')];
  expect(paths).toHaveLength(names.length);
  expect(new Set(paths.map(path => path.getAttribute('d'))).size).toBe(names.length);
  for (const path of paths) {
    expect(path.getAttribute('d')).toMatch(/^M|^m/);
    expect(path.namespaceURI).toBe('http://www.w3.org/2000/svg');
  }
  await Promise.resolve();
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window.parent,
    data: { type: 'pi-web-artifact-theme', dark: true, colors: {} },
  }));
  expect(document.querySelector('#late').innerHTML).toBe('Added later');
  expect(document.querySelectorAll('span > svg')).toHaveLength(names.length);
});
