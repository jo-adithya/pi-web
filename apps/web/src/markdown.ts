import MarkdownIt from "markdown-it";
import highlight from "./syntax";

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

/** Links require an explicit harmless scheme; relative/local/data URLs stay text. */
parser.validateLink = (url: string): boolean => {
  if (/[\u0000-\u0020\u007f]/u.test(url)) return false;
  try {
    const parsed = new URL(url);
    return ["https:", "http:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};
parser.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  token.attrSet("referrerpolicy", "no-referrer");
  return renderer.renderToken(tokens, index, options);
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
