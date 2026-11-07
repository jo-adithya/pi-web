// @vitest-environment node
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";

const viewer = readFileSync(new URL("../../server/src/artifact-preview.html", import.meta.url), "utf8");
const windows = [];
afterEach(() => windows.splice(0).forEach(window => window.close()));

// Render through the viewer's message boundary, including its body replacement.
function render(html, theme) {
  const { window } = new JSDOM(viewer, { runScripts: "dangerously" });
  windows.push(window);
  const headStyle = window.document.head.querySelector("style");
  const send = data => window.dispatchEvent(new window.MessageEvent("message", { source: window.parent, data }));
  send({ type: "pi-web-artifact", html, theme });
  const style = selector => window.getComputedStyle(window.document.querySelector(selector));
  return { window, headStyle, send, style };
}

// JSDOM incorrectly lets UA tag display rules outrank zero-specificity :where rules.
// Spans avoid that engine limitation while exercising the actual bundled selectors.
it("keeps bundled opt-in layout helpers after replacing the receiver body", () => {
  const { window, headStyle, style } = render('<span class="pw-stack pw-gap-3 pw-pad-4"><span class="pw-row"></span><span class="pw-grid"></span></span>');
  expect(window.document.head.querySelector("style")).toBe(headStyle);
  expect(window.document.body.querySelector("script")).toBeNull();
  expect(style(".pw-stack").display).toBe("flex");
  expect(style(".pw-stack").flexDirection).toBe("column");
  expect(style(".pw-stack").gap).toBe("16px");
  expect(style(".pw-stack").padding).toBe("24px");
  expect(style(".pw-row").display).toBe("flex");
  expect(style(".pw-row").flexWrap).toBe("wrap");
  expect(style(".pw-row").alignItems).toBe("center");
  expect(style(".pw-grid").display).toBe("grid");
  expect(style(".pw-grid").gridTemplateColumns).toBe("repeat(auto-fit, minmax(min(100%, 14rem), 1fr))");
});

it.each([[1, 4], [2, 8], [3, 16], [4, 24]])("applies spacing step %i", (step, pixels) => {
  const { style } = render(`<div class="pw-card pw-gap-${step} pw-pad-${step}"></div>`);
  expect(style("div").gap).toBe(`${pixels}px`);
  expect(style("div").padding).toBe(`${pixels}px`);
});

it("provides card and text helpers without restyling plain markup", () => {
  const plain = '<article><h2>Heading</h2><p>Body</p></article>';
  const baseline = render(plain);
  const { style } = render(`${plain}<section class="pw-card"><span class="pw-title">Title</span><span class="pw-text pw-small">Text</span></section>`);
  expect(style(".pw-card").padding).toBe("16px");
  expect(style(".pw-card").borderRadius).toBe("12px");
  expect(style(".pw-card").minWidth).toBe("0px");
  expect(style(".pw-title").margin).toBe("0px");
  expect(style(".pw-title").lineHeight).toBe("1.25");
  expect(style(".pw-text").margin).toBe("0px");
  expect(style(".pw-text").lineHeight).toBe("1.6");
  expect(style(".pw-small").fontSize).toBe("14px");
  for (const selector of ["article", "article h2", "article p"]) {
    for (const property of ["display", "margin", "padding", "gap", "fontSize", "lineHeight", "borderRadius"]) {
      expect(style(selector)[property]).toBe(baseline.style(selector)[property]);
    }
  }
  expect(style("article").display).toBe("block");
  expect(style("article").gap).toBe("");
});

it("lets artifact CSS override bundled helpers", () => {
  const { style } = render('<style>section { display: block; gap: 7px; padding: 11px; border-radius: 2px; } p { margin: 9px; line-height: 2; }</style><section class="pw-stack pw-card pw-gap-3 pw-pad-4"><p class="pw-text">Custom</p></section>');
  expect(style("section").display).toBe("block");
  expect(style("section").gap).toBe("7px");
  expect(style("section").padding).toBe("11px");
  expect(style("section").borderRadius).toBe("2px");
  expect(style("p").margin).toBe("9px");
  expect(style("p").lineHeight).toBe("2");
});

// JSDOM does not resolve inherited CSS variables in computed colors.
it.skip("updates card and muted colors from live theme tokens (requires browser CSS variable resolution)", () => {
  const { send, style } = render('<section class="pw-card"><p class="pw-muted">Secondary</p></section>', {
    dark: false, colors: { card: "white", "card-foreground": "black", border: "gray", "muted-foreground": "blue" },
  });
  expect(style("section").backgroundColor).toBe("rgb(255, 255, 255)");
  expect(style("section").color).toBe("rgb(0, 0, 0)");
  expect(style("section").borderTopColor).toBe("rgb(128, 128, 128)");
  expect(style("p").color).toBe("rgb(0, 0, 255)");
  send({ type: "pi-web-artifact-theme", dark: true, colors: { card: "black", "card-foreground": "white", border: "red", "muted-foreground": "yellow" } });
  expect(style("section").backgroundColor).toBe("rgb(0, 0, 0)");
  expect(style("section").color).toBe("rgb(255, 255, 255)");
  expect(style("section").borderTopColor).toBe("rgb(255, 0, 0)");
  expect(style("p").color).toBe("rgb(255, 255, 0)");
});
