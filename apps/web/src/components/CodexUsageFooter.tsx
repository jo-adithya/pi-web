import { Button } from "@kobalte/core/button";
import { Popover } from "@kobalte/core/popover";
import { For, Show, createEffect, createSignal, onSettled } from "solid-js";
import type { SessionModel } from "../session-model";
import type { CodexWindow } from "../generated/protocol";
import { Icon } from "./Icon";

/** Uses provider durations rather than assuming every subscription has the same windows. */
function windowLabel(window: CodexWindow): string {
  const seconds = window.durationSeconds;
  return seconds === 604800 ? "week" : seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.round(seconds / 60)}m`;
}

/** Formats a Unix-seconds reset deadline relative to the browser clock, rounded up to minutes. */
function resetCountdown(resetsAt: number, now: number): string {
  const minutes = Math.ceil((resetsAt * 1000 - now) / 60_000);
  if (minutes <= 0) return "Reset pending · Refresh to confirm";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const parts = days ? [[days, "day"], [hours, "hour"]] : [[hours, "hour"], [minutes % 60, "minute"]];
  return `Resets in ${parts.filter(([count]) => count).map(([count, unit]) => `${count} ${unit}${count === 1 ? "" : "s"}`).join(", ")}`;
}

/** Selected-conversation quota summary and reset details; refreshes on mount, visibility and opening. */
export function CodexUsageFooter(props: { model: SessionModel }) {
  const model = props.model;
  const [open, setOpen] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [content, setContent] = createSignal<HTMLElement>();
  let trigger!: HTMLButtonElement;
  // Non-modal content gets focus without trapping navigation through the rest of the page.
  createEffect(() => open() ? content() : undefined, element => element?.focus({ preventScroll: true }));
  const eligible = () => model.online() && model.state.status.process === "ready" && model.state.settings.model?.provider === "openai-codex";
  /** Requests fresh usage only for a visible, connected Codex session. */
  const refresh = () => {
    setNow(Date.now());
    if (eligible() && document.visibilityState === "visible") model.send({ type: "refresh_codex_usage" });
  };
  onSettled(() => {
    refresh();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  });
  createEffect(eligible, enabled => { if (!enabled) setOpen(false); });
  createEffect(open, expanded => {
    if (!expanded) return;
    // Only the displayed countdown ticks; quota requests remain user/visibility driven.
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  });
  const usage = () => eligible() ? model.state.codexUsage : null;
  const label = () => {
    const value = usage();
    if (!value?.windows.length) return value?.loading ? "Codex loading…" : "Codex unavailable";
    return `Codex ${value.windows.map(w => `${windowLabel(w)} ${Math.round(w.usedPercent)}% used`).join(" · ")}${value.stale ? " · stale" : ""}`;
  };
  return <Popover open={open()} onOpenChange={expanded => {
    if (!expanded && content()?.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    setOpen(expanded);
    if (expanded) refresh();
  }} placement="top" gutter={10}>
    <Popover.Trigger ref={trigger} type="button" class="codex-usage" disabled={!eligible()} aria-busy={usage()?.loading ? "true" : "false"} aria-label={`View Codex usage. ${label()}${usage()?.loading ? ". Refreshing usage" : ""}`}>
      <Show when={usage()?.loading}><span class="working-dot" title="Refreshing usage" aria-hidden="true" /></Show>
      <span>{label()}</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content ref={setContent} class="codex-usage-popover">
        <div class="codex-usage-heading">
          <Popover.Title>Codex usage</Popover.Title>
          <Popover.CloseButton class="icon-button" aria-label="Close usage details"><Icon name="close" /></Popover.CloseButton>
        </div>
        <Show when={usage()?.windows.length} fallback={<p class="codex-usage-empty" role="status">{usage()?.loading ? "Loading usage…" : "Usage unavailable. Connect with Codex OAuth, then refresh to try again."}</p>}>
          <div class="codex-usage-windows">
            <For each={usage()?.windows ?? []} keyed={window => window.identity}>{window => {
              const name = () => window().durationSeconds === 604800 ? "Weekly" : windowLabel(window());
              return <section class="codex-usage-window">
                <div class="codex-usage-window-heading"><strong>{name()} limit</strong><span>{Math.round(window().usedPercent)}% used</span></div>
                <progress max="100" value={window().usedPercent} aria-label={`${name()} usage`} />
                <div class="codex-usage-window-detail">
                  <span>{Math.round(100 - window().usedPercent)}% remaining</span>
                  <span class="codex-usage-reset" title={new Date(window().resetsAt * 1000).toLocaleString()}>{resetCountdown(window().resetsAt, now())}</span>
                </div>
              </section>;
            }}</For>
          </div>
          <Show when={usage()?.stale}><p class="codex-usage-stale" role="status">Refresh failed; showing the last successful reading.</p></Show>
        </Show>
        <div class="codex-usage-actions">
          <span>{usage()?.observedAt != null ? `Updated ${new Date(usage()!.observedAt! * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "No reading yet"}</span>
          <Button type="button" disabled={usage()?.loading || !eligible()} onClick={refresh}>{usage()?.loading ? "Refreshing…" : "Refresh usage"}</Button>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover>;
}
