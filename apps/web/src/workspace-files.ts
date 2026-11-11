import { loadCapability } from "./browser-auth";

export interface WorkspaceFiles { paths: string[]; truncated: boolean }
export interface SourcePreview { path: string; firstLine: number; text: string }

/** Loads a bounded, current-source excerpt; it is never a historical snapshot. */
export async function loadSource(session: string, path: string, line: number, signal: AbortSignal, proof = loadCapability()): Promise<SourcePreview> {
  if (!proof) throw new Error("Open the current login link before reading source.");
  const response = await fetch(`/files/${encodeURIComponent(session)}/source`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    headers: { "content-type": "application/json", "x-pi-capability": proof },
    body: JSON.stringify({ path, line }), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) {
    if (response.status === 422) { const failure: unknown = await response.json(); if (failure && typeof failure === "object" && "error" in failure && typeof failure.error === "string" && failure.error.length < 256) throw new Error(failure.error); }
    throw new Error("Current source is unavailable. Check the connection and file path.");
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("path" in value) || value.path !== path || !("firstLine" in value) ||
    typeof value.firstLine !== "number" || !Number.isSafeInteger(value.firstLine) || value.firstLine < 1 || value.firstLine > line ||
    !("text" in value) || typeof value.text !== "string" || new TextEncoder().encode(value.text).length > 65536 || value.text.split("\n").length > 80) throw new Error("Invalid source preview.");
  return { path, firstLine: value.firstLine, text: value.text };
}

/** Lists relative paths for a registered conversation's workspace using explicit proof.
 * The caller owns cancellation; failures leave the prompt untouched.
 */
export async function searchWorkspaceFiles(session: string, query: string, signal: AbortSignal, proof = loadCapability()): Promise<WorkspaceFiles> {
  if (!proof) throw new Error("Open the current login link before searching files.");
  const response = await fetch(`/files/${encodeURIComponent(session)}`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    headers: { "content-type": "application/json", "x-pi-capability": proof },
    body: JSON.stringify({ query }), signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) throw new Error("File search unavailable. Your draft was kept.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("paths" in value) || !("truncated" in value) ||
    !Array.isArray(value.paths) || value.paths.length > 50 || typeof value.truncated !== "boolean" ||
    !value.paths.every((path: unknown) => typeof path === "string" && path.length > 0 && path.length <= 1024 &&
      !path.startsWith("/") && !path.split("/").some(part => part === ".." || part === "." || !part) && !/[\p{Cc}]/u.test(path))) {
    throw new Error("File search returned invalid paths. Your draft was kept.");
  }
  return { paths: [...new Set(value.paths as string[])], truncated: value.truncated };
}
