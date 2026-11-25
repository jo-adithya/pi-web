/** Private RPC adapter. The backend owns notes and source evidence; tools never write workspace files. */
export const NOTE_PREFIX = "pi-web:review-note:v1:";
interface Context {
  mode: string;
  ui: { input(title: string, placeholder?: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined> };
}
interface Tool {
  name: string; label: string; description: string; defaultActive: boolean;
  parameters: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: unknown, ctx: Context): Promise<{ content: { type: "text"; text: string }[]; details: undefined }>;
}
/** Structural SDK port, exercised through the native RPC protocol and a deterministic host fixture. */
export interface NoteHost {
  registerTool(tool: Tool): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  on(event: "before_agent_start", handler: (event: { prompt: string }) => void): void;
  on(event: "agent_settled" | "session_shutdown", handler: () => void): void;
}
const names = ["record_review_note", "list_review_notes", "delete_review_note"];
const id = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" };
const version = { type: "integer", minimum: 1 };
const note = {
  type: "object", additionalProperties: false, required: ["path", "side", "line", "quote", "text"],
  properties: {
    path: { type: "string", maxLength: 1024, description: "Literal workspace-relative tracked path" },
    side: { type: "string", enum: ["new", "old"], description: "Use old only for deleted lines" },
    line: { type: "integer", minimum: 1, maximum: 1000000000 },
    quote: { type: "string", maxLength: 240, description: "Exact source line without the diff prefix" },
    text: { type: "string", minLength: 1, maxLength: 600, description: "Non-obvious rationale, trade-offs or limitations; not proof of correctness" },
    chapter: { type: "string", maxLength: 80, description: "Optional grouping title, at most 80 UTF-8 bytes" },
  },
};

/** Activates three current-turn tools only for backend-marked prompts. Settlement closes access;
 * continuations retain the same token. RPC replies contain short receipts or at most eight notes,
 * never source patches. A timeout is an uncertain outcome: list before retrying mutations.
 */
export default function registerReviewNotes(pi: NoteHost): void {
  let turn: string | undefined;
  const activate = () => pi.setActiveTools([...pi.getActiveTools().filter(name => !names.includes(name)), ...(turn ? names : [])]);
  pi.on("before_agent_start", event => {
    const marker = /\n\[Pi Web review notes turn ([A-Za-z0-9_-]{1,80}:[0-9]{1,20})\]\s*$/.exec(event.prompt);
    if (marker) turn = marker[1];
    activate();
  });
  const close = () => { turn = undefined; activate(); };
  pi.on("agent_settled", close);
  pi.on("session_shutdown", close);
  const definitions = [
    { name: names[0], action: "record", description: "Create a current-turn author note and capture its actual source hunk now. Choose a stable ID. For replacement, supply the version returned by record/list; rationale and evidence are replaced together. Maximum eight notes. Does not verify claims or change source code.", properties: { id, version, note }, required: ["id", "note"] },
    { name: names[1], action: "list", description: "Read up to eight author notes and their versions from this implementation turn. Returns rationale and coordinates, not patches or saved review history. Captured evidence may become stale after later edits.", properties: {}, required: [] },
    { name: names[2], action: "delete", description: "Delete one note from this implementation turn using its exact current version. Cannot delete saved review history, user discussions, or notes from another turn.", properties: { id, version }, required: ["id", "version"] },
  ];
  for (const definition of definitions) {
    pi.registerTool({
      name: definition.name, label: definition.name, description: definition.description, defaultActive: false,
      annotations: { readOnlyHint: definition.action === "list", destructiveHint: definition.action === "delete", openWorldHint: false },
      parameters: { type: "object", additionalProperties: false, properties: definition.properties, required: definition.required },
      async execute(_id, args, signal, _update, ctx) {
        if (ctx.mode !== "rpc" || !turn) throw new Error("Review-note tools require an active opted-in Pi Web turn");
        signal?.throwIfAborted();
        const request = NOTE_PREFIX + JSON.stringify({ turn, operation: { ...args, action: definition.action } });
        if (new TextEncoder().encode(request).length > 8192) throw new Error("Review-note request exceeds 8 KiB");
        const response = await ctx.ui.input(request, undefined, { signal, timeout: 15000 });
        if (response === undefined) throw new Error("Review-note request cancelled or timed out. It may have applied; list notes before retrying");
        if (new TextEncoder().encode(response).length > 48 * 1024) throw new Error("Review-note response exceeds 48 KiB");
        const reply = JSON.parse(response) as { error?: string; data?: unknown };
        if (reply.error) throw new Error(reply.error);
        if (!reply.data || typeof reply.data !== "object") throw new Error("Invalid review-note reply");
        return { content: [{ type: "text", text: JSON.stringify(reply.data) }], details: undefined };
      },
    });
  }
}
