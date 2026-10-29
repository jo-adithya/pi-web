import type { WorkspaceReply } from "./generated/protocol";
import { activity, processStatus } from "./client-state";
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const utf8 = new TextEncoder();
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && utf8.encode(value).length <= max;
/** Project folders are absolute server-local paths, never browser uploads. */
export function validWorkspacePath(value: unknown): value is string {
  return boundedText(value, 1024) && value.startsWith("/") && !value.includes("\0");
}
/** Validate the bounded multi-project catalog independently from session v1 frames. */
export function decodeWorkspace(text: string): WorkspaceReply {
  if (text.length > 262_144) throw new Error("Catalog frame too large");
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.v !== 2 || typeof value.ok !== "boolean" || !boundedText(value.code, 128) || !(value.requestId === null || boundedText(value.requestId, 64)) || !id(value.selected) || !id(value.selectedWorkspace) || !(value.target === null || id(value.target)) || !Array.isArray(value.sessions) || value.sessions.length > 512 || !Array.isArray(value.workspaces) || value.workspaces.length === 0 || value.workspaces.length > 16) throw new Error("Invalid workspace envelope");
  const workspaces = new Map<string, number>();
  for (const workspace of value.workspaces) {
    if (!object(workspace) || !id(workspace.workspaceId) || workspaces.has(workspace.workspaceId) || !boundedText(workspace.name, 64) || !validWorkspacePath(workspace.path)) throw new Error("Invalid workspace entry");
    workspaces.set(workspace.workspaceId, 0);
  }
  const ids = new Set<string>(); let active = 0; let selectedWorkspace: string | undefined;
  for (const entry of value.sessions) {
    if (!object(entry) || !id(entry.sessionId) || ids.has(entry.sessionId) || !id(entry.workspaceId) || !workspaces.has(entry.workspaceId) || !boundedText(entry.title, 64) || !["open", "stopping", "stopped", "cleanup_failed"].includes(String(entry.lifecycle))) throw new Error("Invalid catalog entry");
    ids.add(entry.sessionId);
    const count = workspaces.get(entry.workspaceId)! + 1;
    if (count > 32) throw new Error("Workspace conversation limit exceeded");
    workspaces.set(entry.workspaceId, count);
    if (entry.sessionId === value.selected) selectedWorkspace = entry.workspaceId;
    if (entry.lifecycle !== "stopped") active++;
    if (entry.runtime !== null && (!object(entry.runtime) || !id(entry.runtime.epoch) || !processStatus(entry.runtime.process) || !activity(entry.runtime.activity))) throw new Error("Invalid runtime summary");
    if ((entry.lifecycle === "stopped") !== (entry.runtime === null)) throw new Error("Invalid catalog lifecycle");
  }
  if (!ids.has(value.selected) || selectedWorkspace !== value.selectedWorkspace || active > 4 || value.target !== null && !ids.has(value.target as string)) throw new Error("Invalid catalog selection, target or active count");
  if (value.ok && ["created", "opened", "workspace_added", "workspace_selected"].includes(value.code) && (value.target === null || value.requestId === null)) throw new Error("Missing operation target");
  return value as unknown as WorkspaceReply;
}
