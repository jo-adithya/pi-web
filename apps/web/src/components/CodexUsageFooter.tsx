import { Button } from "@kobalte/core/button";
import { onSettled } from "solid-js";
import type { SessionModel } from "../session-model";
import type { CodexWindow } from "../generated/protocol";

/** Uses provider durations rather than assuming every subscription has the same windows. */
function windowLabel(window: CodexWindow): string {
  const seconds = window.durationSeconds;
  return seconds === 604800 ? "week" : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.round(seconds / 60)}m`;
}

/** Selected-conversation usage: opening, visible-again and taps refresh; no polling timer. */
export function CodexUsageFooter(props: { model: SessionModel }) {
  const model = props.model;
  const eligible = () => model.online() && model.state.status.process === "ready" && model.state.settings.model?.provider === "openai-codex";
  /** Requests fresh usage only for a visible, connected Codex session. */
  const refresh = () => {
    if (eligible() && document.visibilityState === "visible") model.send({ type: "refresh_codex_usage" });
  };
  onSettled(() => {
    refresh();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  });
  const usage = () => eligible() ? model.state.codexUsage : null;
  const label = () => {
    const value = usage();
    if (!value?.windows.length) return value?.loading ? "Codex loading…" : "Codex unavailable";
    return `Codex ${value.windows.map(w => `${windowLabel(w)} ${Math.round(w.usedPercent)}% used`).join(" · ")}${value.stale ? " · stale" : ""}${value.loading ? " · refreshing…" : ""}`;
  };
  const details = () => {
    const value = usage();
    if (!value?.windows.length) return "Subscription usage unavailable. Tap to refresh when using Codex OAuth.";
    return `${value.windows.map(w => `${windowLabel(w)} reset reported for ${new Date(w.resetsAt * 1000).toLocaleString()}`).join("; ")}. Observed ${new Date(value.observedAt! * 1000).toLocaleString()}. ${value.stale ? "Refresh failed; showing last successful reading. " : ""}Only a fresh reading confirms a reset. Tap to refresh.`;
  };
  return <Button type="button" class="codex-usage" disabled={!eligible()} aria-label={`Refresh Codex usage. ${label()}. ${details()}`} title={details()} onClick={refresh}>{label()}</Button>;
}
