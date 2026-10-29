import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";

const html = readFileSync("index.html", "utf8");

/** Runs the HTML's blocking theme initializer without loading the application. */
function initialize(saved: string | null, systemDark: boolean, denied = false) {
  const page = new DOMParser().parseFromString(html, "text/html");
  const script = page.head.querySelector<HTMLScriptElement>('script[src="/assets/theme-init.js"]');
  expect(script, "theme must initialize in the head before the app module").not.toBeNull();
  expect(script!.type).not.toBe("module");
  expect(script!.hasAttribute("async")).toBe(false);
  expect(script!.hasAttribute("defer")).toBe(false);
  const source = readFileSync("public/assets/theme-init.js", "utf8");
  runInNewContext(source, {
    document,
    window: {
      localStorage: { getItem: (key: string) => {
        expect(key).toBe("pi-web.theme.v1");
        if (denied) throw new Error("Storage denied");
        return saved;
      } },
      matchMedia: (query: string) => {
        expect(query).toBe("(prefers-color-scheme: dark)");
        return { matches: systemDark };
      },
    },
  });
}

afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  ["dark", false, true], ["dark", true, true],
  ["light", true, false], ["light", false, false],
  [null, true, true], [null, false, false],
  ["system", true, true], ["invalid", false, false],
] as const)("applies saved %s with system dark=%s before startup", (saved, systemDark, dark) => {
  initialize(saved, systemDark);
  expect(document.documentElement.classList.contains("dark")).toBe(dark);
});

it.each([true, false])("uses system dark=%s when storage is unavailable", systemDark => {
  initialize(null, systemDark, true);
  expect(document.documentElement.classList.contains("dark")).toBe(systemDark);
});
