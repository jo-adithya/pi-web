import { Collapsible } from "@kobalte/core/collapsible";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { BackgroundTask, BackgroundStatus } from "../generated/protocol";
import { Icon } from "./Icon";

const labels: Record<BackgroundStatus, string> = { active: "Queued / running", completed: "Completed", steered: "Steered", error: "Failed", aborted: "Aborted", stopped: "Stopped", unknown: "Interrupted" };

/** Runtime activity summary and task identities/statuses; results stay out of this panel. */
export function BackgroundTasks(props: { tasks: BackgroundTask[] }) {
  const [open, setOpen] = createSignal(false);
  const summary = createMemo(() => {
    const active = props.tasks.filter(task => task.status === "active").length;
    const failed = props.tasks.filter(task => task.status === "error").length;
    return `${props.tasks.length} ${props.tasks.length === 1 ? "task" : "tasks"}${active ? ` · ${active} queued / running` : ""}${failed ? ` · ${failed} failed` : ""}`;
  });
  return <Show when={props.tasks.length > 0}>
    <Collapsible class="background-tasks" open={open()} onOpenChange={setOpen} forceMount>
      <Collapsible.Trigger class="background-tasks-trigger">
        <Icon name="chevronDown" />
        <span class="background-tasks-summary" role="status" aria-live="polite">
          <span class="background-tasks-title">Background agents & workflows</span>
          <span class="background-tasks-count">{summary()}</span>
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content class="background-tasks-content" hidden={!open()}>
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
      </Collapsible.Content>
    </Collapsible>
  </Show>;
}
