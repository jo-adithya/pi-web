import highlight from "./syntax";
import { diffLines, type DiffLine } from "./local-review";

interface Token { text: string; className: string }
export interface HighlightedLine extends DiffLine { tokens?: Token[] }
const languages: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  rs: "rust", py: "python", pyi: "python", json: "json", jsonc: "json",
  sh: "bash", bash: "bash", css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  yaml: "yaml", yml: "yaml",
};

/** Converts the highlighter's escaped markup to text tokens, preserving multiline spans.
 * Only text and class names reach the renderer; source code is never inserted as HTML.
 */
function tokenLines(source: string, language: string): Token[][] {
  const template = document.createElement("template");
  // Character references survive HTML's CR/CRLF normalization, keeping diff rows exact.
  template.innerHTML = highlight.highlight(source, { language, ignoreIllegals: true }).value.replace(/\r/g, "&#13;");
  const lines: Token[][] = [[]];
  function walk(node: Node, className: string) {
    if (node.nodeType === Node.TEXT_NODE) {
      (node.textContent ?? "").split("\n").forEach((text, index) => {
        if (index) lines.push([]);
        if (text) lines[lines.length - 1].push({ text, className });
      });
    } else {
      const scope = node instanceof Element ? `${className} ${node.className}`.trim() : className;
      for (const child of node.childNodes) walk(child, scope);
    }
  }
  walk(template.content, "");
  return lines;
}

/** Highlights known-language patches up to 16 KiB and 400 lines; others remain plain.
 * Old/new sides are parsed separately within each hunk, preserving multiline syntax
 * where context exists. Missing file context between hunks cannot be reconstructed.
 * Metadata, binary notices and diff markers are always plain text.
 */
export function highlightDiff(path: string, patch: string): { lines: HighlightedLine[]; label: string } {
  const lines: HighlightedLine[] = diffLines(patch);
  const extension = path.split("/").pop()!.split(".").pop()!.toLowerCase();
  const language = Object.hasOwn(languages, extension) ? languages[extension] : undefined;
  if (!language) return { lines, label: "Plain text" };
  if (new TextEncoder().encode(patch).length > 16384 || lines.length > 400) return { lines, label: "Plain text · large diff" };
  let hunk: HighlightedLine[] = [];
  const paint = () => {
    for (const side of ["remove", "add"] as const) {
      const rows = hunk.filter(line => line.kind === side || line.kind === "context");
      if (!rows.length) continue;
      const tokens = tokenLines(rows.map(line => line.text.slice(1)).join("\n"), language);
      rows.forEach((line, index) => { line.tokens = tokens[index]; });
    }
    hunk = [];
  };
  for (const line of lines) {
    if (line.kind !== "header") hunk.push(line);
    // The no-newline marker does not interrupt a hunk's syntax context.
    else if (!line.text.startsWith("\\")) paint();
  }
  paint();
  return { lines, label: lines.some(line => line.tokens) ? `${highlight.getLanguage(language)!.name} · syntax` : "Plain text" };
}
