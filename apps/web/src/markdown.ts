import MarkdownIt from "markdown-it";
import highlight from "./syntax";
import { codeReference } from "./code-reference";

const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  highlight(code, language) {
    // Highlight only known, short, completed fences. No automatic language detection.
    if (code.length > 8192 || !highlight.getLanguage(language)) return "";
    return highlight.highlight(code, { language, ignoreIllegals: true }).value;
  },
});

/** Links use harmless external schemes or explicit workspace source coordinates. */
parser.validateLink = (url: string): boolean => {
  if (/[\u0000-\u0020\u007f]/u.test(url)) return false;
  if (codeReference(url)) return true;
  try {
    const parsed = new URL(url);
    return ["https:", "http:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};
parser.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index];
  if (codeReference(String(token.attrGet("href") ?? ""))) {
    token.attrSet("data-code-reference", String(token.attrGet("href")));
    token.attrSet("href", "#");
    token.attrSet("class", "code-reference");
    return renderer.renderToken(tokens, index, options);
  }
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  token.attrSet("referrerpolicy", "no-referrer");
  return renderer.renderToken(tokens, index, options);
};
parser.core.ruler.push("source_reference_context", state => {
  for (const token of state.tokens) {
    let link = false;
    for (const child of token.children ?? []) {
      if (child.type === "link_open") link = true;
      if (child.type === "code_inline") child.meta = { inLink: link };
      if (child.type === "link_close") link = false;
    }
  }
});
parser.renderer.rules.code_inline = (tokens, index) => {
  const content = tokens[index].content, escaped = parser.utils.escapeHtml(content);
  return !tokens[index].meta?.inLink && codeReference(content) ? `<a href="#" class="code-reference" data-code-reference="${escaped}"><code>${escaped}</code></a>` : `<code>${escaped}</code>`;
};
// Never automatically fetch an agent-supplied remote image or render inline SVG.
parser.renderer.rules.image = () => '<span class="image-omitted">[Image omitted]</span>';

export type MarkdownPart = { kind: "markdown"; html: string } | { kind: "artifact"; source: string };

/** Splits completed top-level `html preview` fences from bounded safe Markdown.
 * Unclosed fences remain code; callers decide whether the message may contain artifacts.
 */
export function renderMarkdownParts(text: string): MarkdownPart[] {
  const bounded = text.slice(0, 65_536);
  const environment = {};
  const tokens = parser.parse(bounded, environment);
  // Match the parser's line maps for LF, CRLF, and lone CR input.
  const lines = bounded.split(/\r\n?|\n/);
  const parts: MarkdownPart[] = [];
  let start = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "fence" || token.level !== 0 || token.info.trim() !== "html preview" || !token.map) continue;
    const closing = lines[token.map[1] - 1] ?? "";
    const marker = token.markup[0] === "`" ? "`" : "~";
    if (!new RegExp(`^ {0,3}${marker}{${token.markup.length},}[ \\t]*$`).test(closing)) continue;
    if (index > start) parts.push({ kind: "markdown", html: parser.renderer.render(tokens.slice(start, index), parser.options, environment) });
    parts.push({ kind: "artifact", source: token.content });
    start = index + 1;
  }
  if (start < tokens.length) parts.push({ kind: "markdown", html: parser.renderer.render(tokens.slice(start), parser.options, environment) });
  return parts;
}

/** Renders a completed, bounded message using this module's fixed safe Markdown policy.
 * Streaming callers must render plain text instead. No plugins or raw HTML are enabled.
 */
export function renderMarkdown(text: string): string {
  return parser.render(text.slice(0, 65_536));
}
