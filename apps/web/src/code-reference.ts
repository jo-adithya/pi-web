/** Workspace-relative source coordinates. Lines are one-based and inclusive. */
export interface CodeLocation { path: string; line: number; endLine: number }

/** Recognizes explicit source references while keeping filesystem and executable URLs inert. */
export function codeReference(value: string): CodeLocation | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return; }
  const match = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/.exec(decoded) ?? (/\.[A-Za-z][A-Za-z0-9]*$/.test(decoded) ? ["", decoded, "1"] : null);
  if (!match) return;
  const path = match[1].replace(/^\.\//, ""), line = Number(match[2] ?? match[3]), endLine = Number(match[4] ?? line);
  if (!path || path.length > 1024 || /[\s\p{Cc}\\:#?<>"']/u.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      !Number.isSafeInteger(line) || line < 1 || line > 10_000_000 || !Number.isSafeInteger(endLine) || endLine < line || endLine > 10_000_000) return;
  return { path, line, endLine };
}
