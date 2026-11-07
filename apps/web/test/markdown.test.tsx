import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import highlight from "highlight.js/lib/core";
import { renderMarkdown, renderMarkdownParts } from "../src/markdown";
import { sanitizeArtifact } from "../src/html-artifact";
import { Markdown } from "../src/components/Markdown";

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.classList.remove("dark"); document.documentElement.style.removeProperty("--background"); });

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
    expect(send).toHaveBeenCalledWith({ type: "pi-web-artifact", html: source + "\n" }, "*");
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
  it("sends the resolved Pi Web theme on load and updates the same frame when it changes", async () => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.setProperty("--background", "#171c22");
    const view = render(() => <Markdown text={'```html preview\n<div>Themed</div>\n```'} complete allowArtifacts />);
    flush();
    const frame = view.container.querySelector("iframe")!;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    await fireEvent.load(frame); flush();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: true, colors: expect.objectContaining({ background: "#171c22" }) }), "*");
    send.mockClear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.setProperty("--background", "#ffffff");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: false, colors: expect.objectContaining({ background: "#ffffff" }) }), "*"));
    expect(view.container.querySelector("iframe")).toBe(frame);
    view.unmount();
    send.mockClear();
    document.documentElement.classList.add("dark");
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
  it("keeps inline and full-screen previews synchronized with the same theme", async () => {
    const view = render(() => <Markdown text={'```html preview\n<div>Themed</div>\n```'} complete allowArtifacts />);
    await fireEvent.click(view.getByText("Expand")); flush();
    const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe")];
    expect(frames).toHaveLength(2);
    const sends = frames.map(frame => vi.spyOn(frame.contentWindow!, "postMessage"));
    for (const frame of frames) await fireEvent.load(frame);
    for (const send of sends) expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: false }), "*");
    document.documentElement.classList.add("dark");
    await vi.waitFor(() => {
      for (const send of sends) expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "pi-web-artifact-theme", dark: true }), "*");
    });
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
  it("keeps artifact CSS and SVG geometry but removes active content, navigation and URL attributes", () => {
    const source = `<style>.card{color:teal;background:url(https://attacker.invalid/css)}</style><div class="card" onclick="alert(1)">Card</div><svg viewBox="0 0 100 100"><path d="M0 0 L10 10"/><foreignObject><iframe src="/auth"></iframe></foreignObject><animate attributeName="href" to="https://attacker.invalid"/><image href="https://attacker.invalid/image"/></svg><script>alert(1)</script><img src="https://attacker.invalid/img"><meta http-equiv="refresh" content="0;url=/auth"><base href="https://attacker.invalid"><form action="/auth"><input></form><a href="/auth" target="_top" ping="https://attacker.invalid">Link</a>`;
    const element = document.createElement("div"); element.innerHTML = sanitizeArtifact(source);
    expect(element.querySelector(".card")?.textContent).toBe("Card");
    expect(element.querySelector("style")?.textContent).toContain("color:teal");
    expect(element.querySelector("svg path")?.getAttribute("d")).toBe("M0 0 L10 10");
    expect(element.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(element.querySelector("script,img,iframe,object,embed,meta,base,form,input,foreignObject,animate,image")).toBeNull();
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
