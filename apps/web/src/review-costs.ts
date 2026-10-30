import type { GroupInput, IntentGroup } from "./review-groups";
import { normalizeGroups } from "./review-groups";

export interface GroupModel { provider: string; id: string }
export interface GroupOptions { model?: GroupModel; maxCalls: number; maxRequestBytes: number; includeGenerated: boolean }
export interface GroupUsage {
  calls: number; requestBytes: number; reportedCalls: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; pricedCalls: number; reused: boolean;
}
export const emptyUsage = (): GroupUsage => ({ calls: 0, requestBytes: 0, reportedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, pricedCalls: 0, reused: false });

/** Distinguishes partial provider telemetry from measured totals and free cache reuse. */
export function groupingUsageLabel(usage: GroupUsage): string {
  if (usage.reused) return "Saved result · 0 new AI calls";
  const tokens = usage.reportedCalls
    ? `${usage.inputTokens.toLocaleString()} input / ${usage.outputTokens.toLocaleString()} output tokens · ${usage.cacheReadTokens.toLocaleString()} cache-read / ${usage.cacheWriteTokens.toLocaleString()} cache-write tokens (${usage.reportedCalls}/${usage.calls} calls reported)`
    : "Token usage unavailable";
  const cost = usage.pricedCalls ? `$${usage.costUsd.toFixed(4)} reported cost (${usage.pricedCalls}/${usage.calls} calls priced; provider estimate)` : "Cost unavailable";
  return `${usage.calls} AI calls · ${(usage.requestBytes / 1024).toFixed(1)} KiB sent · ${tokens} · ${cost}`;
}

/** Conservative generated-artifact hints for grouping only. Source files remain visible and reviewable. */
export function noisyFile(path: string): boolean {
  return /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock)$/.test(path)
    || /\.(min\.(js|css)|map)$/.test(path) || /(^|\/)(dist|build|coverage)\//.test(path);
}

/** Separates trusted usage accounting from model groups; unavailable fields never become measured zero. */
export function accountResponse(value: unknown, previous: GroupUsage): { result: unknown; usage: GroupUsage } {
  if (!value || typeof value !== "object" || !("usage" in value)) return { result: value, usage: previous };
  const { usage, ...result } = value;
  if (!usage || typeof usage !== "object") throw new Error("Invalid grouping usage.");
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  const next = { ...previous, reportedCalls: previous.reportedCalls + 1 };
  for (const key of fields) {
    const n = (usage as Record<string, unknown>)[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(next[key] + n)) throw new Error("Invalid grouping usage.");
    next[key] += n;
  }
  const cost = "costUsd" in usage ? usage.costUsd : null;
  if (cost !== null) {
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(next.costUsd + cost)) throw new Error("Invalid grouping cost.");
    next.costUsd += cost; next.pricedCalls++;
  }
  return { result, usage: next };
}

/** Bounded tab-local result cache. Stores suggestions, never patches or credentials; storage failure is optional. */
export function createGroupCache(namespace?: string) {
  const entries = new Map<string, IntentGroup[]>();
  const storageKey = namespace ? `pi-review-groups-v2:${namespace}` : undefined;
  if (storageKey) {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw && raw.length <= 256 * 1024) {
        const saved: unknown = JSON.parse(raw);
        if (Array.isArray(saved) && saved.length <= 4) for (const entry of saved) {
          if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[0].length <= 2048 && Array.isArray(entry[1])) entries.set(entry[0], entry[1]);
        }
      }
    } catch { /* Private browsing and storage limits must not block review. */ }
  }
  function get(key: string, files: GroupInput[]) {
    const groups = entries.get(key);
    if (!groups) return;
    try { return normalizeGroups({ groups }, files); } catch { entries.delete(key); }
  }
  function put(key: string, groups: IntentGroup[]) {
    entries.delete(key); entries.set(key, groups);
    while (entries.size > 4 || JSON.stringify([...entries]).length > 256 * 1024) entries.delete(entries.keys().next().value!);
    if (storageKey) try { sessionStorage.setItem(storageKey, JSON.stringify([...entries])); } catch { /* Memory reuse remains available. */ }
  }
  return { get, put };
}
