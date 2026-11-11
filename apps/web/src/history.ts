import type { HistoryRequest, HistoryResponse } from "./generated/protocol";
import { validHistoryResponse } from "./client-state";

/** Reads one authenticated replacement page or original. The caller owns cancellation. */
export async function readHistory(session: string, input: HistoryRequest, epoch: string, signal: AbortSignal, proof: string | null): Promise<HistoryResponse> {
  if (!proof) throw new Error("Open the current login link before reading history.");
  const response = await fetch(`/history/${encodeURIComponent(session)}`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    headers: { "content-type": "application/json", "x-pi-capability": proof },
    body: JSON.stringify(input), signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
  });
  if (!response.ok) {
    if (response.status === 422) {
      const failure: unknown = await response.json();
      if (failure && typeof failure === "object" && "error" in failure && typeof failure.error === "string" && failure.error.length <= 512) throw new Error(failure.error);
    }
    throw new Error("History is unavailable. Try again when Pi is idle.");
  }
  const value: unknown = await response.json();
  if (!validHistoryResponse(value) || value.epoch !== epoch) throw new Error("History changed. Return to the latest replies and try again.");
  return value;
}
