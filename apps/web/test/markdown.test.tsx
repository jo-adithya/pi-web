import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import highlight from "highlight.js/lib/core";
import { renderMarkdown, renderMarkdownParts } from "../src/markdown";
import { sanitizeArtifact } from "../src/html-artifact";
import * as artifactLibrary from "../src/artifact-library";
import { Markdown } from "../src/components/Markdown";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.classList.remove("dark"); document.documentElement.removeAttribute("style"); });

function rendered(text: string): HTMLDivElement {
  const element = document.createElement("div"); element.innerHTML = renderMarkdown(text); return element;
}

describe("Markdown trust boundary", () => {
  it("renders a completed opt-in HTML artifact between Markdown paragraphs, with source access", async () => {
    const source = '<style>.card { color: teal; }</style><div class="card">Before → After</div>';
    const result = render(() => <Markdown text={`Before\n\n\`\`\`html preview\n${source}\n\`\`\`\n\nAfter`} complete allowArtifacts />);
    const frame = result.container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("/artifact-preview");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(result.container.querySelector(".card")).toBeNull();
    expect(result.queryByText("Static HTML/CSS/SVG · scripts and network access disabled")).toBeNull();
    expect(result.container.textContent).toContain("Before");
    expect(result.container.textContent).toContain("After");
    const send = vi.spyOn(frame!.contentWindow!, "postMessage");
    await fireEvent.load(frame!); flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact", html: source + "\n", theme: expect.objectContaining({ dark: false }) }), "*");
    expect(send).toHaveBeenCalledTimes(1);
    await fireEvent.load(frame!); flush();
    document.documentElement.classList.add("dark");
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.filter(([data]) => data.type === "pi-web-artifact")).toHaveLength(1);
    await fireEvent.click(result.getByRole("button", { name: "Source" })); flush();
    expect(result.container.querySelector("pre")?.textContent).toBe(source + "\n");
    await fireEvent.click(result.getByRole("button", { name: /^Preview$/ })); flush();
    expect(result.container.querySelector("iframe")).not.toBeNull();
    await fireEvent.click(result.getByRole("button", { name: "Expand" })); flush();
    const dialog = within(document.body).getByRole("dialog", { name: "HTML preview" });
    expect(dialog.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(within(dialog).queryByText("Static HTML/CSS/SVG · scripts and network access disabled")).toBeNull();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Close full screen" })); flush();
    expect(within(document.body).queryByRole("dialog")).toBeNull();
  });
  it("accepts bounded heights only from its own viewer and retains height after unloading", async () => {
    let visibility!: (visible: boolean) => void;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { visibility = visible => { callback([{ isIntersecting: visible }]); flush(); }; }
      observe() {}
      disconnect() {}
    });
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(() => <Markdown text={'```html preview\n<div>Measured</div>\n```'} complete allowArtifacts />);
    flush(); visibility(true);
    const frame = view.container.querySelector("iframe")!;
    await fireEvent.load(frame); flush();
    const send = (height: unknown, source: MessageEventSource | null = frame.contentWindow) => {
      window.dispatchEvent(new MessageEvent("message", { source, data: { type: "pi-web-artifact-size", height } })); flush();
    };
    send(310);
    expect(frame.style.height).toBe("310px");
    for (const height of [NaN, Infinity, -1, 0, 79, 20001, "500", null]) send(height);
    send(500, window);
    expect(frame.style.height).toBe("310px");
    send(80); expect(frame.style.height).toBe("80px");
    send(20000); expect(frame.style.height).toBe("20000px");
    send(245.2); expect(frame.style.height).toBe("246px");
    visibility(false);
    expect((view.container.querySelector(".artifact-placeholder") as HTMLElement).style.height).toBe("246px");
    const listener = add.mock.calls.find(([type]) => type === "message")![1];
    expect(remove).toHaveBeenCalledWith("message", listener);
    await fireEvent.click(view.getByRole("button", { name: "Expand" })); flush();
    const dialog = within(document.body).getByRole("dialog");
    const fullFrame = dialog.querySelector("iframe")!;
    await fireEvent.load(fullFrame); flush();
    window.dispatchEvent(new MessageEvent("message", { source: fullFrame.contentWindow, data: { type: "pi-web-artifact-size", height: 800 } })); flush();
    expect(fullFrame.style.height).toBe("");
    expect((view.container.querySelector(".artifact-placeholder") as HTMLElement).style.height).toBe("246px");
  });
  it("collapses inline content and reopens preview, source, or full screen on demand", async () => {
    const view = render(() => <Markdown text={'```html preview\n<div>Inline visual</div>\n```'} complete allowArtifacts />);
    expect(view.container.querySelector("iframe")).not.toBeNull();
    const collapse = view.getByRole("button", { name: "Collapse" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    await fireEvent.click(collapse); flush();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.querySelector(".artifact-placeholder")).toBeNull();
    expect(view.getByRole("button", { name: "Show" }).getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(view.getByRole("button", { name: "Show" })); flush();
    expect(view.container.querySelector("iframe")).not.toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Collapse" })); flush();
    expect(view.getByRole("button", { name: /^Preview$/ }).getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(view.getByRole("button", { name: "Source" })); flush();
    expect(view.container.querySelector("pre")?.textContent).toContain("Inline visual");
    await fireEvent.click(view.getByRole("button", { name: "Collapse" })); flush();
    expect(view.container.querySelector("pre")).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: /^Preview$/ })); flush();
    expect(view.container.querySelector("iframe")).not.toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Collapse" })); flush();
    await fireEvent.click(view.getByRole("button", { name: "Expand" })); flush();
    const dialog = within(document.body).getByRole("dialog", { name: "HTML preview" });
    expect(dialog.querySelector("iframe")).not.toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Collapse" })).toBeNull();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Close full screen" })); flush();
    expect(view.container.querySelector("iframe")).toBeNull();
  });
  it("shows an actionable library failure without delivering a broken preview", async () => {
    vi.spyOn(artifactLibrary, "artifactChartJs").mockRejectedValue(new Error("offline"));
    const view = render(() => <Markdown text={'```html preview\n<script data-library="chart.js"></script>\n```'} complete allowArtifacts />);
    const frame = view.container.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    await fireEvent.load(frame); flush();
    await vi.waitFor(() => expect(view.getByRole("alert").textContent).toContain("Reload the page"));
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["unmount", "navigation"])("discards a pending library after %s", async action => {
    let resolve!: (value: string) => void;
    vi.spyOn(artifactLibrary, "artifactChartJs").mockReturnValue(new Promise<string>(done => { resolve = done; }));
    const view = render(() => <Markdown text={'```html preview\n<script data-library="chart.js"></script>\n```'} complete allowArtifacts />);
    const frame = view.container.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    await fireEvent.load(frame); flush();
    if (action === "unmount") view.unmount();
    else await fireEvent.load(frame);
    flush();
    resolve("window.Chart = {}");
    await Promise.resolve(); flush();
    expect(send).not.toHaveBeenCalled();
  });
  it("mounts viewers only near the viewport, while source and full-screen access remain available", async () => {
    let visibility!: (visible: boolean) => void;
    const observe = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        visibility = visible => { callback([{ isIntersecting: visible }]); flush(); };
      }
      observe = observe;
      disconnect = disconnect;
    });
    const view = render(() => <Markdown text={'```html preview\n<div>Lazy visual</div>\n```'} complete allowArtifacts />);
    flush();
    expect(observe).toHaveBeenCalledWith(view.container.querySelector(".html-artifact"));
    expect(view.container.querySelector("iframe")).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Source" })); flush();
    expect(view.container.querySelector("pre")?.textContent).toContain("Lazy visual");
    await fireEvent.click(view.getByRole("button", { name: /^Preview$/ })); flush();
    expect(view.container.querySelector("iframe")).toBeNull();
    visibility(true);
    expect(view.container.querySelector("iframe")).not.toBeNull();
    visibility(false);
    expect(view.container.querySelector("iframe")).toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Expand" })); flush();
    const dialog = within(document.body).getByRole("dialog", { name: "HTML preview" });
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(dialog.querySelector("iframe")).not.toBeNull();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Close full screen" })); flush();
    expect(view.container.querySelector("iframe")).toBeNull();
    visibility(true);
    expect(view.container.querySelector("iframe")).not.toBeNull();
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("keeps source access in full-screen and restores focus after Escape", async () => {
    const source = '<div class="card">Full-screen source</div>';
    const result = render(() => <Markdown text={`\`\`\`html preview\n${source}\n\`\`\``} complete allowArtifacts />);
    const expand = result.getByRole("button", { name: "Expand" });
    expand.focus();
    await fireEvent.click(expand); flush();
    const dialog = within(document.body).getByRole("dialog", { name: "HTML preview" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Source" })); flush();
    expect(dialog.querySelector("pre")?.textContent).toBe(source + "\n");
    await fireEvent.keyDown(dialog, { key: "Escape" }); flush();
    expect(within(document.body).queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
    expect(result.container.querySelector("pre")?.textContent).toBe(source + "\n");
  });
  it("swaps preview surfaces in both themes without changing app colors", async () => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.setProperty("--background", "#171c22");
    document.documentElement.style.setProperty("--card", "#252b33");
    const view = render(() => <Markdown text={'```html preview\n<div>Themed</div>\n```'} complete allowArtifacts />);
    flush();
    const frame = view.container.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    await fireEvent.load(frame); flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact", theme: expect.objectContaining({ dark: true, colors: expect.objectContaining({ background: "#252b33", card: "#171c22" }) }) }), "*");
    send.mockClear();
    document.documentElement.classList.remove("dark");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#171c22");
    expect(document.documentElement.style.getPropertyValue("--card")).toBe("#252b33");
    document.documentElement.style.setProperty("--background", "#fafafa");
    document.documentElement.style.setProperty("--card", "#ffffff");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: false, colors: expect.objectContaining({ background: "#ffffff", card: "#fafafa" }) }), "*"));
    send.mockClear();
    document.documentElement.classList.add("dark");
    document.documentElement.style.setProperty("--background", "#171c22");
    document.documentElement.style.setProperty("--card", "#252b33");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: true, colors: expect.objectContaining({ background: "#252b33", card: "#171c22" }) }), "*"));
    expect(view.container.querySelector("iframe")).toBe(frame);
    view.unmount();
    send.mockClear();
    document.documentElement.classList.add("dark");
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
  it("forwards the optional radius token on load and live updates", async () => {
    document.documentElement.style.setProperty("--radius", "0.625rem");
    const view = render(() => <Markdown text={'```html preview\n<div>Radius</div>\n```'} complete allowArtifacts />);
    const frame = view.container.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    await fireEvent.load(frame); flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact", theme: expect.objectContaining({ colors: expect.objectContaining({ radius: "0.625rem" }) }) }), "*");
    send.mockClear();
    document.documentElement.style.setProperty("--radius", "0.75rem");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", colors: expect.objectContaining({ radius: "0.75rem" }) }), "*"));
  });
  it("shares one theme observer and palette read across mounted viewers, releasing it after the last viewer", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const text = '```html preview\n<div>Shared theme</div>\n```';
    const first = render(() => <Markdown text={text} complete allowArtifacts />);
    const second = render(() => <Markdown text={text} complete allowArtifacts />);
    flush();
    const themeObservers = observe.mock.calls.flatMap(([target, options], index) =>
      target === document.documentElement && options?.attributeFilter?.includes("class") ? [observe.mock.contexts[index]] : []);
    expect(themeObservers).toHaveLength(1);
    const disconnect = vi.spyOn(themeObservers[0] as MutationObserver, "disconnect");
    const frames = [first, second].map(view => view.container.querySelector("iframe")!);
    const sends = frames.map(frame => vi.spyOn(frame.contentWindow!, "postMessage"));
    for (const frame of frames) await fireEvent.load(frame);
    for (const send of sends) send.mockClear();
    const styles = vi.spyOn(window, "getComputedStyle");
    document.documentElement.classList.add("dark");
    await vi.waitFor(() => {
      for (const send of sends) expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: true }), "*");
    });
    expect(styles.mock.calls.filter(([element]) => element === document.documentElement)).toHaveLength(1);
    first.unmount();
    expect(disconnect).not.toHaveBeenCalled();
    for (const send of sends) send.mockClear();
    document.documentElement.classList.remove("dark");
    await vi.waitFor(() => expect(sends[1]).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: false }), "*"));
    expect(sends[0]).not.toHaveBeenCalled();
    second.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    const restored = render(() => <Markdown text={text} complete allowArtifacts />);
    flush();
    const frame = restored.container.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    await fireEvent.load(frame);
    document.documentElement.classList.add("dark");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: true }), "*"));
  });
  it("sends semantic text, surface, border and solid-fill colors on load and theme changes", async () => {
    const names = ["primary", "error", "success", "warning", "info", "cyan", "orange", "pink"]
      .flatMap(name => [name, `${name}-foreground`, `${name}-muted`, `${name}-border`]);
    const colors = Object.fromEntries(names.map((name, index) => [name, `oklch(0.5 0.1 ${index * 10})`]));
    for (const [name, value] of Object.entries(colors)) document.documentElement.style.setProperty(`--${name}`, value);
    const view = render(() => <Markdown text={'```html preview\n<div>Semantic colors</div>\n```'} complete allowArtifacts />);
    const frame = view.container.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    await fireEvent.load(frame); flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact", theme: expect.objectContaining({ colors: expect.objectContaining(colors) }) }), "*");
    send.mockClear();
    document.documentElement.classList.add("dark");
    const darkColors = Object.fromEntries(names.map((name, index) => [name, `oklch(0.8 0.1 ${index * 10})`]));
    for (const [name, value] of Object.entries(darkColors)) document.documentElement.style.setProperty(`--${name}`, value);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: true, colors: expect.objectContaining(darkColors) }), "*"));
    expect(view.container.querySelector("iframe")).toBe(frame);
  });
  it("keeps only one viewer active in full-screen and restores the inline preview with the current theme", async () => {
    const view = render(() => <Markdown text={'```html preview\n<div>Themed</div>\n```'} complete allowArtifacts />);
    await fireEvent.click(view.getByText("Expand")); flush();
    const dialog = within(document.body).getByRole("dialog", { name: "HTML preview" });
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(view.container.querySelector("iframe")).toBeNull();
    const frame = dialog.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    await fireEvent.load(frame);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact", theme: expect.objectContaining({ dark: false }) }), "*");
    document.documentElement.classList.add("dark");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: true }), "*"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Close full screen" })); flush();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    const restored = view.container.querySelector("iframe")!;
    const restoredSend = vi.spyOn(restored.contentWindow!, "postMessage");
    await fireEvent.load(restored);
    expect(restoredSend).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact", theme: expect.objectContaining({ dark: true }) }), "*");
  });
  it("keeps ordinary, unclosed, nested and streaming fences inert", () => {
    for (const text of ["```html\n<div>Code</div>\n```", "```html preview\n<div>Unclosed</div>", "> ```html preview\n> <div>Nested</div>\n> ```"]) {
      expect(renderMarkdownParts(text).every(part => part.kind === "markdown")).toBe(true);
    }
    const text = "```html preview\n<div>Preview</div>\n```";
    for (const suffix of ["", "\n", "\n\nAfter"]) {
      const parts = renderMarkdownParts((text + suffix).replaceAll("\n", "\r\n"));
      expect(parts.some(part => part.kind === "artifact")).toBe(true);
      if (suffix.includes("After")) expect(parts).toContainEqual({ kind: "markdown", html: "<p>After</p>\n" });
    }
    const view = render(() => <Markdown text={text} complete={false} allowArtifacts />);
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.querySelector("pre")?.textContent).toBe(text);
    expect(renderMarkdownParts("x".repeat(65536) + "\n" + text).every(part => part.kind === "markdown")).toBe(true);
  });
  it("keeps artifact CSS and SVG geometry but removes external active content, navigation and URL attributes", () => {
    const source = `<style>.card{color:teal;background:url(https://attacker.invalid/css)}</style><div class="card" onclick="alert(1)">Card</div><svg viewBox="0 0 100 100"><path d="M0 0 L10 10"/><foreignObject><iframe src="/auth"></iframe></foreignObject><animate attributeName="href" to="https://attacker.invalid"/><image href="https://attacker.invalid/image"/></svg><script>alert(1)</script><img src="https://attacker.invalid/img"><meta http-equiv="refresh" content="0;url=/auth"><base href="https://attacker.invalid"><form action="/auth"><input></form><a href="/auth" target="_top" ping="https://attacker.invalid">Link</a>`;
    const element = document.createElement("div"); element.innerHTML = sanitizeArtifact(source);
    expect(element.querySelector(".card")?.textContent).toBe("Card");
    expect(element.querySelector("style")?.textContent).toContain("color:teal");
    expect(element.querySelector("svg path")?.getAttribute("d")).toBe("M0 0 L10 10");
    expect(element.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(element.querySelector("img,iframe,object,embed,meta,base,form,input,foreignObject,animate,image")).toBeNull();
    expect(element.querySelector("[onclick],[href],[src],[ping],[target]")).toBeNull();
    for (const markup of ['<math><mtext><img src=x onerror=alert(1)></mtext></math>', '<svg><style><a id="</style><img src=x onerror=alert(1)>"></a></style></svg>', '<template><script>alert(1)</script></template>']) {
      element.innerHTML = sanitizeArtifact(markup);
      expect(element.querySelector("script,img,style,template,math,[onerror]")).toBeNull();
    }
  });
  it("escapes raw HTML and never creates scripts, SVG or remote image requests", () => {
    const result = rendered('<script>alert(1)</script>\n<img src="https://attacker.invalid/track" onerror="alert(1)">\n<svg onload="alert(1)"></svg>\n![alt](https://attacker.invalid/track)');
    expect(result.querySelector("script,img,svg,iframe")).toBeNull();
    expect(result.textContent).toContain("<script>"); expect(result.textContent).toContain("[Image omitted]");
  });
  it("blocks active/local/relative links and makes supported links isolated", () => {
    for (const url of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "file:///etc/passwd", "//attacker.invalid", "/api/control", "vbscript:evil"]) {
      expect(rendered(`[label](${url})`).querySelector("a")).toBeNull();
    }
    const anchor = rendered("[docs](https://example.org/path?q=1)").querySelector("a")!;
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer"); expect(anchor.target).toBe("_blank");
    expect(anchor.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
  it("highlights only a registered short completed fence", () => {
    const spy = vi.spyOn(highlight, "highlight");
    expect(rendered("```rust\nlet value = 1;\n```").querySelector(".hljs-keyword")).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    rendered("```unknown\n<script>\n```"); rendered(`\`\`\`rust\n${"x".repeat(9000)}\n\`\`\``);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("keeps HTML fences inert with the shared review grammars", () => {
    const result = rendered('```html\n<img src="https://attacker.invalid/track" onerror="alert(1)"><script>alert(1)</script>\n```');
    expect(result.querySelector(".hljs-name")?.textContent).toBe("img");
    expect(result.querySelector("img,script")).toBeNull();
    expect(result.textContent).toContain('<script>alert(1)</script>');
  });
  it("does not parse or highlight during streaming and replaces with final Markdown", () => {
    const spy = vi.spyOn(highlight, "highlight");
    const [text, setText] = createSignal("```rust\nlet x = ");
    const [complete, setComplete] = createSignal(false);
    const result = render(() => <Markdown text={text()} complete={complete()} />);
    setText("```rust\nlet x = 1;\n```"); flush();
    expect(result.container.querySelector("pre.streaming-text")?.textContent).toContain("```rust");
    expect(spy).not.toHaveBeenCalled();
    setComplete(true); flush();
    expect(result.container.querySelector(".hljs-keyword")).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
