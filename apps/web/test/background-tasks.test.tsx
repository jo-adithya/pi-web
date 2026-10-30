import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { applyServer, decodeServer, initialState } from "../src/client-state";
import { BackgroundTasks } from "../src/components/BackgroundTasks";
import type { BackgroundTask, BackgroundStatus } from "../src/generated/protocol";

const task: BackgroundTask = { id: "a", kind: "agent", name: "Scout", description: "Inspect events", status: "active", result: null, error: null, truncated: false };
afterEach(cleanup);

test("background status is accepted independently of idle transcript activity", () => {
  const state = initialState(); state.sessionId = "session"; state.epoch = "epoch";
  const message = decodeServer(JSON.stringify({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "background_tasks", tasks: [task] } }));
  expect(applyServer(state, message)).toBe("applied");
  expect(state).toHaveProperty("backgroundTasks.0.status", "active");
  expect(state.status.activity).toBe("idle");
});

test("a compact Agents button opens a modal with scannable rows and no result output", () => {
  const view = { ...render(() => <BackgroundTasks tasks={[task, { ...task, id: "b", name: "Reviewer", status: "completed", result: "<script>private()</script>", truncated: true }]} />), ...within(document.body) };
  const outer = view.getByRole("button", { name: "Agents" });
  expect(outer.getAttribute("aria-haspopup")).toBe("dialog");
  expect(view.queryByRole("dialog")).toBeNull();
  expect(view.getByRole("status").textContent).toContain("1 queued / running");
  expect(view.queryByRole("list")).toBeNull();
  fireEvent.click(outer); flush();
  expect(view.getByRole("dialog", { name: "Background agents & workflows" })).toBeTruthy();
  const list = view.getByRole("list", { name: "Background tasks" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("Scout")).toBeTruthy();
  expect(within(list).getByText("Reviewer")).toBeTruthy();
  expect(within(list).getByText("Completed")).toBeTruthy();
  expect(within(list).queryByRole("button")).toBeNull();
  expect(view.queryByText("<script>private()</script>")).toBeNull();
  expect(view.queryByText(/Result shortened/)).toBeNull();
  expect(view.container.querySelector("pre, script")).toBeNull();
});

test("live refresh preserves the modal and updates summary and rows", () => {
  const [tasks, setTasks] = createSignal<BackgroundTask[]>([task, { ...task, id: "b", name: "Reviewer" }]);
  const view = { ...render(() => <BackgroundTasks tasks={tasks()} />), ...within(document.body) };
  const outer = view.getByRole("button", { name: "Agents" });
  fireEvent.click(outer); flush();
  const scout = view.getByText("Scout").closest("li");
  setTasks([{ ...task, id: "b", name: "Reviewer", status: "error", error: "<img src=x onerror=fail()>" }, { ...task, status: "completed", result: "Fresh result" }]); flush();
  expect(view.getByRole("dialog")).toBeTruthy();
  expect(view.getByRole("status").textContent).toContain("1 failed");
  expect(view.getByRole("status").textContent).not.toContain("queued / running");
  expect(view.getByText("Scout").closest("li")).toBe(scout);
  expect(view.getByText("Completed")).toBeTruthy();
  expect(view.getByText("Failed")).toBeTruthy();
  expect(view.getByText("<img src=x onerror=fail()>").closest("[hidden]")).toBeNull();
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.queryByText("Fresh result")).toBeNull();
});

test("empty background activity removes the button and dismisses the modal", () => {
  const [tasks, setTasks] = createSignal<BackgroundTask[]>([]);
  const view = { ...render(() => <BackgroundTasks tasks={tasks()} />), ...within(document.body) };
  expect(view.container.textContent).toBe("");
  expect(view.queryByRole("button")).toBeNull();
  setTasks([task]); flush();
  expect(view.getByRole("button", { name: "Agents" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(view.getByRole("button", { name: "Agents" })); flush();
  expect(view.getByRole("dialog")).toBeTruthy();
  setTasks([]); flush();
  expect(view.queryByRole("dialog")).toBeNull();
  setTasks([task]); flush();
  expect(view.queryByRole("dialog")).toBeNull();
  setTasks([]); flush();
  expect(view.container.textContent).toBe("");
  expect(view.queryByRole("status")).toBeNull();
});

test("workflows have a distinct kind label but no result preview", () => {
  const workflow: BackgroundTask = { ...task, id: "wf_review", kind: "workflow", name: "Review changes", description: "Check correctness", status: "completed", result: "Review complete" };
  const view = { ...render(() => <BackgroundTasks tasks={[task, workflow]} />), ...within(document.body) };
  fireEvent.click(view.getByRole("button", { name: "Agents" })); flush();
  const row = view.getByText("Review changes").closest("li")!;
  expect(within(row).getByText("Workflow")).toBeTruthy();
  expect(within(row).getByText("Check correctness")).toBeTruthy();
  expect(view.getByText("Agent")).toBeTruthy();
  expect(view.queryByText("Review complete")).toBeNull();
  const state = initialState(); state.sessionId = "session"; state.epoch = "epoch";
  const message = decodeServer(JSON.stringify({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "background_tasks", tasks: [workflow] } }));
  expect(applyServer(state, message)).toBe("applied");
  expect(state.backgroundTasks[0].kind).toBe("workflow");
});

test("active workflows explain the lack of live phase progress without fake progress bars", () => {
  const view = { ...render(() => <BackgroundTasks tasks={[{ ...task, kind: "workflow" }]} />), ...within(document.body) };
  fireEvent.click(view.getByRole("button", { name: "Agents" })); flush();
  expect(view.getByText("Workflow phase progress is not available.")).toBeTruthy();
  expect(view.queryByRole("progressbar")).toBeNull();
});

test("all terminal states have explicit labels instead of being called completed", () => {
  const statuses: BackgroundStatus[] = ["completed", "steered", "error", "aborted", "stopped", "unknown"];
  const view = { ...render(() => <BackgroundTasks tasks={statuses.map(status => ({ ...task, id: status, name: status, status, description: "" }))} />), ...within(document.body) };
  fireEvent.click(view.getByRole("button", { name: "Agents" })); flush();
  for (const label of ["Completed", "Steered", "Failed", "Aborted", "Stopped", "Interrupted"]) expect(view.getByText(label)).toBeTruthy();
  expect(view.queryByText(/No result available/)).toBeNull();
});

test.each(["button", "Escape", "backdrop"])("dismisses via %s and returns focus to Agents", async method => {
  render(() => <BackgroundTasks tasks={[task]} />);
  const view = within(document.body);
  const trigger = view.getByRole("button", { name: "Agents" });
  trigger.focus(); fireEvent.click(trigger); flush();
  const dialog = view.getByRole("dialog");
  const close = within(dialog).getByRole("button", { name: "Close agents" });
  close.focus();
  fireEvent.keyDown(close, { key: "Tab" }); flush();
  expect(document.activeElement).toBe(close);
  if (method === "button") fireEvent.click(close);
  else if (method === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
  else fireEvent.click(document.querySelector(".action-overlay")!);
  flush();
  expect(view.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("decoder rejects malformed or oversized tasks and hello clears runtime cache", () => {
  const state = initialState(); state.sessionId = "session"; state.epoch = "epoch";
  const frame = (tasks: unknown) => JSON.stringify({ v: 1, sessionId: "session", epoch: "epoch", body: { type: "background_tasks", tasks } });
  applyServer(state, decodeServer(frame([task])));
  for (const tasks of [Array(33).fill(task), [{ ...task, kind: "invalid" }], [{ ...task, status: "running" }], [{ ...task, result: "😀".repeat(2049) }], [{ ...task, error: 2 }]]) expect(() => decodeServer(frame(tasks))).toThrow();
  expect(applyServer(state, { ...decodeServer(frame([])), epoch: "old" })).toBe("ignore");
  expect(state.backgroundTasks).toHaveLength(1);
  applyServer(state, { v: 1, sessionId: "session", epoch: "new", body: { type: "hello", project: "test", process: "ready" } });
  expect(state.backgroundTasks).toEqual([]);
});
