import { createSignal } from "solid-js";
import type { ReviewRequest } from "./local-review";

export interface StructuralRequest extends ReviewRequest { path: string; fingerprint: string }
export interface StructuralLine {
  kind: "header" | "context" | "add" | "remove";
  /** One-based source line numbers; absent for hunk separators or the opposite side. */
  old?: number;
  next?: number;
  segments: { text: string; changed: boolean }[];
}
export interface StructuralDiff { mode: "structural"; engine: string; language: string; lines: StructuralLine[] }
export type StructuralResult = StructuralDiff | { mode: "text"; reason: string };
export type StructuralLoader = (request: StructuralRequest, signal: AbortSignal) => Promise<StructuralResult>;

const invalid = () => new Error("Invalid structural comparison response. Showing text diff.");
const shortString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const lineNumber = (value: unknown) => value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000);

/** Fetches a selected-file comparison with snapshot proof, capability auth, and an eight-second browser deadline. */
export async function fetchStructuralReview(id: string, request: StructuralRequest, signal: AbortSignal, capability: string | null): Promise<StructuralResult> {
  if (!capability) throw new Error("Authentication required. Reopen the current terminal URL.");
  const response = await fetch(`/review/${encodeURIComponent(id)}/structural`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { "content-type": "application/json", "x-pi-capability": capability }, body: JSON.stringify(request),
  });
  if (response.status === 401 || response.status === 403) throw new Error("Authentication required. Reopen the current terminal URL.");
  if (response.status === 429) throw new Error("Structural comparison is busy. Try again shortly.");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > 1024 * 1024) throw invalid();
  const value: unknown = JSON.parse(text);
  if (!response.ok) {
    if (value && typeof value === "object" && "error" in value && shortString(value.error)) throw new Error(value.error);
    throw new Error("Structural comparison unavailable. Showing text diff.");
  }
  if (!value || typeof value !== "object" || !("mode" in value)) throw invalid();
  if (value.mode === "text" && "reason" in value && shortString(value.reason)) return { mode: "text", reason: value.reason };
  if (value.mode !== "structural" || !("engine" in value) || !shortString(value.engine) || !("language" in value) || !shortString(value.language) ||
      !("lines" in value) || !Array.isArray(value.lines) || value.lines.length > 10000) throw invalid();
  let segments = 0;
  const lines = value.lines.map((line: unknown): StructuralLine => {
    if (!line || typeof line !== "object" || !("kind" in line) || typeof line.kind !== "string" || !["header", "context", "add", "remove"].includes(line.kind) ||
        !("segments" in line) || !Array.isArray(line.segments) || !lineNumber("old" in line ? line.old : undefined) || !lineNumber("next" in line ? line.next : undefined)) throw invalid();
    const old = "old" in line ? line.old as number : undefined, next = "next" in line ? line.next as number : undefined;
    if ((line.kind === "add" && (next === undefined || old !== undefined)) || (line.kind === "remove" && (old === undefined || next !== undefined)) ||
        (line.kind === "context" && old === undefined && next === undefined)) throw invalid();
    segments += line.segments.length; if (segments > 60000) throw invalid();
    return { kind: line.kind as StructuralLine["kind"], old, next, segments: line.segments.map((segment: unknown) => {
      if (!segment || typeof segment !== "object" || !("text" in segment) || typeof segment.text !== "string" || segment.text.includes("\n") ||
          !("changed" in segment) || typeof segment.changed !== "boolean") throw invalid();
      return { text: segment.text, changed: segment.changed };
    }) };
  });
  return { mode: "structural", engine: value.engine, language: value.language, lines };
}

/** Owns one on-demand comparison. Reset cancels work and discards late replies; text is always immediately available. */
export function createStructuralReview(load: StructuralLoader) {
  const [mode, setMode] = createSignal<"text" | "structural">("text");
  const [result, setResult] = createSignal<StructuralDiff>();
  const [busy, setBusy] = createSignal(false);
  const [reason, setReason] = createSignal("");
  let controller: AbortController | undefined;
  function reset() {
    controller?.abort(); controller = undefined;
    setMode("text"); setResult(undefined); setBusy(false); setReason("");
  }
  async function show(request: StructuralRequest) {
    reset(); setMode("structural"); setBusy(true);
    const current = new AbortController(); controller = current;
    try {
      const value = await load(request, current.signal);
      if (controller !== current) return;
      if (value.mode === "text") setReason(value.reason); else setResult(value);
    } catch (error) {
      if (controller === current) setReason(error instanceof Error ? error.message : "Structural comparison unavailable.");
    } finally {
      if (controller === current) { controller = undefined; setBusy(false); }
    }
  }
  return { mode, result, busy, reason, reset, show };
}
