import MarkdownIt from "markdown-it";
import highlight from "highlight.js/lib/core";
import rust from "highlight.js/lib/languages/rust";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";

for (const [name, language] of Object.entries({ rust, javascript, typescript, json, bash, python })) {
  highlight.registerLanguage(name, language);
}

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

/** Renders a completed, bounded message using this module's fixed safe Markdown policy.
 * Streaming callers must render plain text instead. No plugins or raw HTML are enabled.
 */
export function renderMarkdown(text: string): string {
  return parser.render(text.slice(0, 65_536));
}
