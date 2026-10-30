import { Button } from "@kobalte/core/button";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { ActionDialog } from "./ActionDialog";
import type { BackgroundTask, BackgroundStatus } from "../generated/protocol";
import { Icon } from "./Icon";

const labels: Record<BackgroundStatus, string> = { active: "Queued / running", completed: "Completed", steered: "Steered", error: "Failed", aborted: "Aborted", stopped: "Stopped", unknown: "Interrupted" };

/** Compact activity button opening a live agent/workflow status modal, without result output. */
export function BackgroundTasks(props: { tasks: BackgroundTask[] }) {
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;
  createEffect(() => props.tasks.length, count => { if (!count) setOpen(false); });
  const summary = createMemo(() => {
    const active = props.tasks.filter(task => task.status === "active").length;
    const failed = props.tasks.filter(task => task.status === "error").length;
    return `${props.tasks.length} ${props.tasks.length === 1 ? "task" : "tasks"}${active ? ` · ${active} queued / running` : ""}${failed ? ` · ${failed} failed` : ""}`;
  });
  return <Show when={props.tasks.length > 0}>
    <div class="background-tasks">
      <Button ref={trigger} class="background-tasks-trigger" aria-label="Agents" aria-haspopup="dialog" aria-expanded={open() ? "true" : "false"} title={summary()} onClick={() => setOpen(true)}>
        <Icon name="structure" /><span>Agents</span><span class="background-tasks-count" aria-hidden="true">{props.tasks.length}</span>
      </Button>
      <span class="sr-only" role="status" aria-live="polite">{summary()}</span>
      <Show when={open()}>
        <ActionDialog title="Background agents & workflows" description="Live status of background agents and workflows for this conversation." class="background-tasks-dialog" returnFocus={trigger} close={() => setOpen(false)}>
          <p role="status" aria-live="polite" class="background-tasks-count">{summary()}</p>
          <Button class="icon-button background-tasks-close" aria-label="Close agents" title="Close agents" onClick={() => setOpen(false)}><Icon name="close" /></Button>
        <ul class="background-task-list" aria-label="Background tasks">
          <For each={props.tasks} keyed={task => task.id}>{task =>
            <li class="background-task" data-status={task().status}>
              <div class="background-task-heading">
                <span class="background-task-kind">{task().kind === "workflow" ? "Workflow" : "Agent"}</span>
                <span class="background-task-name">{task().name}</span>
                <span class="background-task-status">{labels[task().status]}</span>
              </div>
              <Show when={task().description}><p class="background-task-description">{task().description}</p></Show>
              <Show when={task().error}><p class="background-task-error">{task().error}</p></Show>
              <Show when={task().kind === "workflow" && task().status === "active"}>
                <p class="background-task-note">Workflow phase progress is not available.</p>
              </Show>
            </li>
          }</For>
        </ul>
        </ActionDialog>
      </Show>
    </div>
  </Show>;
}
