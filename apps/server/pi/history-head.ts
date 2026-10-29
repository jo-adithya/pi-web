import type { HistoryHeadReply } from "../../web/src/generated/protocol";

/** Versioned private notification channel; consume it before rendering ordinary notices. */
export const HEAD_PREFIX = "pi-web:history-head:v1:";

/** Read-only Pi APIs used by the history-head command, checked by the native smoke test. */
export interface HistoryHeadContext {
  mode: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getLeafId(): string | null;
  };
  isIdle(): boolean;
  ui: { notify(message: string, type: "info"): void };
}

/** Structural extension port; no runtime SDK import or dependency installation is required. */
export interface HistoryHeadHost {
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, context: HistoryHeadContext): Promise<void>;
  }): void;
}

const encoder = new TextEncoder();

/** Checks decoded UTF-8 size without allocating for an already-oversized string. */
function fits(value: string, bytes: number): boolean {
  return value.length > 0 && value.length <= bytes && encoder.encode(value).length <= bytes;
}

/** Samples metadata in one synchronous call stack without traversing entries or touching files. */
function sample(requestId: string, context: HistoryHeadContext): HistoryHeadReply {
  if (requestId.length === 0 || requestId.length > 64 || /[^A-Za-z0-9_-]/.test(requestId)) {
    return { status: "error", requestId: null, code: "invalid_request" };
  }
  try {
    const head = {
      sessionId: context.sessionManager.getSessionId(),
      sessionFile: context.sessionManager.getSessionFile() ?? null,
      leafId: context.sessionManager.getLeafId(),
      idle: context.isIdle(),
    };
    if (!fits(head.sessionId, 1024) ||
        (head.leafId !== null && !fits(head.leafId, 1024)) ||
        (head.sessionFile !== null && !fits(head.sessionFile, 4096))) {
      return { status: "error", requestId, code: "metadata_limit" };
    }
    return { status: "ok", requestId, head };
  } catch {
    return { status: "error", requestId, code: "metadata_unavailable" };
  }
}

/**
 * Registers `/pi-web-history-head <token>` for backend-owned RPC children.
 * Tokens are 1–64 ASCII letters, digits, underscores or hyphens. A private notify
 * message contains the versioned reply, capped at 8 KiB UTF-8 including its prefix.
 * IDs are capped at 1024 bytes, paths at 4096; failures never echo metadata/errors.
 * Sampling has no await or transcript access. It is a checkpoint, not a write lock
 * or proof of persistence. Consumers must reject stale snapshot work independently.
 * Non-RPC invocation throws before accessing metadata. Load only with --extension;
 * this module creates no files, tools, model calls or global registrations.
 */
export default function registerHistoryHead(pi: HistoryHeadHost): void {
  pi.registerCommand("pi-web-history-head", {
    description: "Read bounded session/leaf metadata for the Pi Web backend",
    handler: async (requestId, context) => {
      if (context.mode !== "rpc") throw new Error("pi-web-history-head requires RPC mode");
      const reply = sample(requestId, context);
      let message = HEAD_PREFIX + JSON.stringify(reply);
      if (encoder.encode(message).length > 8192) {
        const error: HistoryHeadReply = {
          status: "error", requestId: reply.requestId, code: "metadata_limit",
        };
        message = HEAD_PREFIX + JSON.stringify(error);
      }
      context.ui.notify(message, "info");
    },
  });
}
