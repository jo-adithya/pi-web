/** Bundled only for a fresh reply with scoped source. No model argument reaches a filesystem API. */
import { readFileSync } from "node:fs";

const pathParameter = { type: "string", minLength: 1, maxLength: 512 };
const tools = [
  { name: "read_source", description: "Read up to 12 numbered lines starting at a one-based line in a listed sourceFiles snapshot. Long lines are marked as clipped.",
    properties: { path: pathParameter, line: { type: "integer", minimum: 1 } } },
  { name: "search_source", description: "Find a literal string across listed sourceFiles snapshots; returns up to 8 matching locations and short excerpts. Not a repository-wide search.",
    properties: { query: { type: "string", minLength: 1, maxLength: 128 } } },
] as const;

interface LookupHost {
  registerTool(tool: { name: string; label: string; description: string; parameters: object; annotations: object;
    execute(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: { type: "text"; text: string }[]; details: undefined }> }): void;
  setActiveTools(names: string[]): void;
}

export default function register(pi: LookupHost) {
  registerSourceTools(pi, JSON.parse(readFileSync("source-snapshot.json", "utf8")));
}

/** Inputs are the server's immutable path-to-text snapshot, not paths to open. */
export function registerSourceTools(pi: LookupHost, snapshot: Record<string, string>) {
  const sources = new Map(Object.entries(snapshot).map(([path, text]) => {
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return [path, lines] as const;
  }));
  let remaining = 4;
  const excerpt = (path: string, line: number, text: string, match = 0) => {
    const start = Math.max(0, match - 40);
    return { path, line, text: (start ? "[clipped] …" : "") + text.slice(start, start + 240) + (text.length > start + 240 ? "… [clipped]" : "") };
  };
  for (const tool of tools) pi.registerTool({ ...tool, label: tool.name,
    parameters: { type: "object", properties: tool.properties, required: Object.keys(tool.properties), additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      if (remaining <= 0) throw new Error("Source lookup budget exhausted");
      if (--remaining === 0) pi.setActiveTools([]);
      let rows: ReturnType<typeof excerpt>[] = [];
      if (tool.name === "read_source") {
        const lines = typeof args.path === "string" && sources.get(args.path);
        if (!lines || typeof args.line !== "number" || !Number.isSafeInteger(args.line) || args.line < 1 || args.line > lines.length) throw new Error("File or line not in the available snapshot");
        const first = args.line, path = args.path as string;
        rows = lines.slice(first - 1, first + 11).map((text, i) => excerpt(path, first + i, text));
      } else {
        const query = args.query;
        if (typeof query !== "string" || query.length > 128 || !query.trim() || /[\r\n]/.test(query)) throw new Error("Use one short literal search string");
        search: for (const [path, lines] of sources) for (const [index, text] of lines.entries()) {
          const match = text.indexOf(query);
          if (match >= 0) rows.push(excerpt(path, index + 1, text, match));
          if (rows.length === 8) break search;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ scope: "Workspace source at formatting time; not a historical revision or test result", rows }) }], details: undefined };
    },
  });
}
