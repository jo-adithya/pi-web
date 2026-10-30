import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { createTheme } from "../src/theme";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.documentElement.classList.remove("dark");
});

it("keeps browser chrome synchronized with explicit choices and system changes", () => {
  const page = new DOMParser().parseFromString(readFileSync("index.html", "utf8"), "text/html");
  document.head.innerHTML = page.head.innerHTML;
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  let theme!: ReturnType<typeof createTheme>;
  render(() => { theme = createTheme(); return <div />; });
  flush();
  const color = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content;
  expect(color()).toBe("#ffffff");
  theme.setPreference("dark"); flush();
  expect(color()).toBe("#171c22");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  theme.setPreference("light"); flush();
  media.matches = true;
  media.dispatchEvent(new Event("change")); flush();
  expect(color()).toBe("#ffffff");
  theme.setPreference("system"); flush();
  expect(color()).toBe("#171c22");
  media.matches = false;
  media.dispatchEvent(new Event("change")); flush();
  expect(color()).toBe("#ffffff");
});
