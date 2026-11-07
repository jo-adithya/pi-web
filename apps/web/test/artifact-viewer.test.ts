// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("allows inline scripts only in the resource-restricted opaque viewer policy", () => {
  const server = readFileSync(new URL("../../server/src/http.rs", import.meta.url), "utf8");
  expect(server).toContain("script-src 'unsafe-inline'; script-src-attr 'none'; connect-src 'none'; frame-src 'none';");
  expect(server).toContain("sandbox allow-scripts;");
  expect(server).not.toContain("allow-same-origin");
});

it("applies every shipped semantic palette in both themes, accepting only parent messages and allowlisted tokens", () => {
  const viewer = readFileSync(new URL("../../server/src/artifact-preview.html", import.meta.url), "utf8");
  const script = viewer.match(/<script>([\s\S]*?)<\/script>/)![1];
  const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
  const names = ["primary", "error", "success", "warning", "info", "cyan", "orange", "pink"]
    .flatMap(name => [name, `${name}-foreground`, `${name}-muted`, `${name}-border`]);
  const parent = {};
  const root = { classList: { toggle: vi.fn() }, style: { setProperty: vi.fn(), colorScheme: "" } };
  let receive!: (event: { source: object; data: unknown }) => void;
  runInNewContext(script, {
    parent,
    document: { documentElement: root },
    window: { addEventListener: (_type: string, callback: typeof receive) => { receive = callback; } },
  });
  const themes = css.split(".dark {");
  expect(themes).toHaveLength(2);
  for (const [index, theme] of themes.entries()) {
    const colors = Object.fromEntries([...theme.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
    for (const name of names) expect(colors[name], `${name} in ${index ? "dark" : "light"} theme`).toBeTruthy();
    root.style.setProperty.mockClear();
    receive({ source: {}, data: { type: "pi-web-artifact-theme", dark: !!index, colors } });
    expect(root.style.setProperty).not.toHaveBeenCalled();
    receive({ source: parent, data: { type: "pi-web-artifact-theme", dark: !!index, colors: { ...colors, untrusted: "red" } } });
    for (const name of names) expect(root.style.setProperty).toHaveBeenCalledWith(`--${name}`, colors[name]);
    expect(root.style.setProperty).not.toHaveBeenCalledWith("--untrusted", expect.anything());
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", !!index);
    expect(root.style.colorScheme).toBe(index ? "dark" : "light");
  }
});
