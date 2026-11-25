/** Workspace-relative source coordinates. Lines are one-based and inclusive. */
export interface CodeLocation { path: string; line: number; endLine: number }
/** Opens a source preview and restores focus to the trigger on close.
 * With `fallback: "explicit"`, current code requires a separate action when no capture matches.
 */
export type OpenCodeReference = (location: CodeLocation, trigger: HTMLElement, fallback?: "explicit") => void;

/** Parses workspace-relative file and line coordinates. `line` mode requires a cited line;
 * the default also accepts a bare file, treating it as a reference to the first line.
 */
export function codeReference(value: string, mode: "file-or-line" | "line" = "file-or-line"): CodeLocation | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return; }
  const match = /^(.*?)(?::(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)$/.exec(decoded)
    ?? (mode === "file-or-line" && /\.[A-Za-z][A-Za-z0-9]*$/.test(decoded) ? ["", decoded, "1"] : null);
  if (!match) return;
  const path = match[1].replace(/^\.\//, ""), line = Number(match[2] ?? match[4]), endLine = Number(match[3] ?? match[5] ?? line);
  if (!path || path.length > 1024 || /[\s\p{Cc}\\:#?<>"']/u.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      !Number.isSafeInteger(line) || line < 1 || line > 10_000_000 || !Number.isSafeInteger(endLine) || endLine < line || endLine > 10_000_000) return;
  return { path, line, endLine };
}
