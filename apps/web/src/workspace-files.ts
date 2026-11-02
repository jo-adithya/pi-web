import { loadCapability } from "./browser-auth";

export interface WorkspaceFiles { paths: string[]; truncated: boolean }

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
