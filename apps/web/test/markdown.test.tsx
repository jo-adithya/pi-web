import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import highlight from "highlight.js/lib/core";
import { renderMarkdown } from "../src/markdown";
import { Markdown } from "../src/components/Markdown";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function rendered(text: string): HTMLDivElement {
  const element = document.createElement("div"); element.innerHTML = renderMarkdown(text); return element;
}

describe("Markdown trust boundary", () => {
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
