import type { ServerMessage, RuntimeStatus, DisplayMessage, Dialog, ViewPatch, SlashCommand, AgentSettings, ContextUsage, CodexUsage, BackgroundTask } from "./generated/protocol";
export interface ClientState {
  sessionId: string; epoch: string; project: string; seq: number; synced: boolean;
  status: RuntimeStatus; messages: Record<string, DisplayMessage>; order: string[];
  dialogs: Dialog[]; older: boolean; backgroundTasks: BackgroundTask[];
  commands: SlashCommand[]; settings: AgentSettings; contextUsage: ContextUsage | null; codexUsage: CodexUsage | null;
}
export const initialState = (): ClientState => ({ sessionId: "", epoch: "", project: "Pi Web", seq: 0, synced: false,
  status: { process: "starting", activity: "idle", lastOutcome: null, error: null, historyWarning: null, persistence: false, cancelUnconfirmed: false, notice: null, lspStatus: null },
  messages: {}, order: [], dialogs: [], backgroundTasks: [], older: false, commands: [], settings: emptySettings(), contextUsage: null, codexUsage: null });
const emptySettings = (): AgentSettings => ({ models: [], model: null, thinkingLevel: null, thinkingLevels: [], codexFast: null });

/** Applies only contiguous same-epoch deltas. A gap requests a new snapshot;
 * pending commands are deliberately not replayed after reconnect or epoch change.
 */
export function applyServer(state: ClientState, message: ServerMessage): "applied" | "ignore" | "resync" {
  if (message.body.type === "hello") {
    state.sessionId = message.sessionId; state.epoch = message.epoch; state.project = message.body.project; state.synced = false; state.commands = []; state.settings = emptySettings(); state.contextUsage = null; state.codexUsage = null; state.backgroundTasks = []; return "applied";
  }
  if (message.sessionId !== state.sessionId || message.epoch !== state.epoch) return "ignore";
  if (message.body.type === "background_tasks") { state.backgroundTasks = message.body.tasks; return "applied"; }
  if (message.body.type === "codex_usage") { state.codexUsage = message.body.usage; return "applied"; }
  if (message.body.type === "context_usage") { state.contextUsage = message.body.usage; return "applied"; }
  if (message.body.type === "settings") { state.settings = message.body.settings; return "applied"; }
  if (message.body.type === "commands") { state.commands = message.body.commands; return "applied"; }
  if (message.body.type === "snapshot") {
    if (message.epoch === state.epoch && state.synced && message.body.throughSeq < state.seq) return "ignore";
    state.epoch = message.epoch; state.seq = message.body.throughSeq; state.synced = true;
    state.messages = Object.fromEntries(message.body.messages.map(m => [m.id, m])); state.order = message.body.messages.map(m => m.id);
    state.status = message.body.status; state.dialogs = message.body.dialogs; state.older = message.body.olderHistory; return "applied";
  }
  if (message.epoch !== state.epoch) return "ignore";
  if (message.body.type !== "event") return "applied";
  if (message.body.seq <= state.seq) return "ignore";
  if (!state.synced || message.body.seq !== state.seq + 1 || message.body.patches.some(p => p.kind === "snapshot_needed")) { state.synced = false; return "resync"; }
  for (const patch of message.body.patches) applyPatch(state, patch);
  state.seq = message.body.seq; state.status = message.body.status; state.dialogs = message.body.dialogs; state.older = message.body.olderHistory; return "applied";
}
function applyPatch(state: ClientState, patch: ViewPatch) {
  switch (patch.kind) {
    case "message": if (!Object.hasOwn(state.messages, patch.message.id)) state.order.push(patch.message.id); state.messages[patch.message.id] = patch.message; break;
    case "remove": delete state.messages[patch.id]; state.order = state.order.filter(id => id !== patch.id); break;
    case "delta": {
      const message = Object.hasOwn(state.messages, patch.id) ? state.messages[patch.id] : undefined; if (!message) break;
      while (message.blocks.length <= patch.index) message.blocks.push({ kind: "text", text: "" });
      const block = message.blocks[patch.index]; block.kind = patch.thinking ? "thinking" : "text";
      block.text = (block.text + patch.text).slice(0, 65_536); message.truncated ||= patch.truncated; break;
    }
  }
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const string = (v: unknown, max = 65_536): v is string => typeof v === "string" && v.length <= max;
const nullable = (v: unknown): boolean => v === null || string(v);
const array = (v: unknown, max: number, check: (item: unknown) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(check);
const integer = (v: unknown, max = 0xffffffff): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
export const processStatus = (v: unknown) => ["starting", "ready", "stopping", "exited", "failed"].includes(String(v));
export const activity = (v: unknown) => ["idle", "submitting", "reconciling", "running", "retrying", "compacting", "awaiting_input", "cancelling", "failed"].includes(String(v));
const status = (v: unknown): boolean => object(v) && processStatus(v.process) && activity(v.activity) && [v.lastOutcome, v.error, v.historyWarning, v.notice].every(nullable) && (v.lspStatus === null || catalogText(v.lspStatus, 512)) && typeof v.persistence === "boolean" && typeof v.cancelUnconfirmed === "boolean";
const block = (v: unknown): boolean => object(v) && ((v.kind === "image" && typeof v.text === "string" && /^[0-9a-f]{64}$/.test(v.text)) || (["text", "thinking", "notice"].includes(String(v.kind)) && string(v.text)));
const key = (v: unknown): v is string => string(v, 1024) && !["__proto__", "constructor", "prototype"].includes(v);
const display = (v: unknown): boolean => object(v) && key(v.id) && string(v.role, 128) && array(v.blocks, 128, block) && typeof v.complete === "boolean" && nullable(v.error) && typeof v.truncated === "boolean";
const dialog = (v: unknown): boolean => object(v) && [v.id, v.kind, v.title, v.message, v.initial].every(s => string(s)) && array(v.options, 128, s => string(s, 512));
const utf8 = new TextEncoder();
/** Validates catalog text against the server's UTF-8 byte limits. */
const catalogText = (v: unknown, max: number): v is string => string(v, max) && utf8.encode(v).length <= max;
const thinkingLevel = (v: unknown): boolean => typeof v === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v);
const modelOption = (v: unknown): boolean => object(v) && typeof v.images === "boolean" && [v.id, v.provider, v.name].every(value => catalogText(value, 256) && value.length > 0 && !/[\p{Cc}]/u.test(value));
const agentSettings = (v: unknown): boolean => object(v) && array(v.models, 512, modelOption) && (v.model === null || modelOption(v.model)) && (v.thinkingLevel === null || thinkingLevel(v.thinkingLevel)) && Array.isArray(v.thinkingLevels) && array(v.thinkingLevels, 7, thinkingLevel) && new Set(v.thinkingLevels).size === v.thinkingLevels.length && (v.codexFast === null || catalogText(v.codexFast, 512));
const slashCommand = (v: unknown): boolean => object(v) && catalogText(v.name, 256) && v.name.length > 0 && !/^[\/]|[\s\p{Cc}]/u.test(v.name) && (v.description === null || catalogText(v.description, 1024)) && ["extension", "prompt", "skill"].includes(String(v.source));
const patch = (v: unknown): boolean => {
  if (!object(v)) return false;
  switch (v.kind) {
    case "message": return display(v.message);
    case "delta": return key(v.id) && integer(v.index, 127) && typeof v.thinking === "boolean" && string(v.text) && typeof v.truncated === "boolean";
    case "remove": return key(v.id);
    case "activity": return activity(v.activity);
    case "snapshot_needed": return true;
    default: return false;
  }
};
/** Validates the runtime boundary; generated TypeScript alone is not validation. */
export function decodeServer(text: string): ServerMessage {
  if (text.length > 16 * 1024 * 1024) throw new Error("Server frame too large");
  const v: unknown = JSON.parse(text);
  if (!object(v) || v.v !== 1 || !string(v.sessionId, 128) || !string(v.epoch, 128) || !object(v.body)) throw new Error("Invalid server envelope");
  const b = v.body; let valid = false;
  switch (b.type) {
    case "background_tasks": valid = array(b.tasks, 32, t => object(t) && (t.kind === "agent" || t.kind === "workflow") && catalogText(t.id, 128) && typeof t.id === "string" && /^[a-zA-Z0-9_-]+$/.test(t.id) && catalogText(t.name, 128) && catalogText(t.description, 512) && typeof t.status === "string" && ["active", "completed", "steered", "error", "aborted", "stopped", "unknown"].includes(t.status) && (t.result === null || catalogText(t.result, 8192)) && (t.error === null || catalogText(t.error, 1024)) && typeof t.truncated === "boolean"); break;
    case "hello": valid = string(b.project, 4096) && processStatus(b.process); break;
    case "codex_usage": valid = object(b.usage) && [b.usage.loading, b.usage.stale, b.usage.unavailable].every(v => typeof v === "boolean") &&
      (b.usage.observedAt === null || integer(b.usage.observedAt)) && array(b.usage.windows, 2, w => object(w) &&
        ["primary", "secondary"].includes(String(w.identity)) && integer(w.durationSeconds, 366 * 86400) && w.durationSeconds > 0 &&
        typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 && integer(w.resetsAt)); break;
    case "context_usage": valid = b.usage === null || (object(b.usage) && (b.usage.tokens === null || integer(b.usage.tokens, Number.MAX_SAFE_INTEGER)) && integer(b.usage.contextWindow, Number.MAX_SAFE_INTEGER) && b.usage.contextWindow > 0); break;
    case "settings": valid = agentSettings(b.settings); break;
    case "run_completed": valid = string(b.runId, 20) && /^[1-9]\d{0,19}$/.test(b.runId) && typeof b.outcome === "string" && ["success", "error", "aborted"].includes(b.outcome); break;
    case "commands": valid = array(b.commands, 512, slashCommand); break;
    case "snapshot": valid = integer(b.throughSeq) && status(b.status) && array(b.messages, 500, display) && array(b.dialogs, 8, dialog) && typeof b.olderHistory === "boolean"; break;
    case "event": valid = integer(b.seq) && status(b.status) && array(b.patches, 129, patch) && array(b.dialogs, 8, dialog) && typeof b.olderHistory === "boolean"; break;
    case "result": valid = object(b.result) && string(b.result.requestId, 64) && typeof b.result.ok === "boolean" && string(b.result.code, 128) && nullable(b.result.disposition) && nullable(b.result.recoveredDraft); break;
    case "error": valid = string(b.code, 128); break;
  }
  if (!valid) throw new Error("Invalid server message");
  return v as unknown as ServerMessage;
}
