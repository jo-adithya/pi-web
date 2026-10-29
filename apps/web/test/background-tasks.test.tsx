import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
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

test("one disclosure opens scannable rows without nested controls or result output", () => {
  const view = render(() => <BackgroundTasks tasks={[task, { ...task, id: "b", name: "Reviewer", status: "completed", result: "<script>private()</script>", truncated: true }]} />);
  const outer = view.getByRole("button", { name: /Background agents & workflows/ });
  expect(outer.getAttribute("aria-expanded")).toBe("false");
  expect(view.getByRole("status").textContent).toContain("1 queued / running");
  expect(view.queryByRole("list")).toBeNull();
  fireEvent.click(outer); flush();
  expect(outer.getAttribute("aria-expanded")).toBe("true");
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

test("live refresh preserves the outer disclosure and updates summary and rows", () => {
  const [tasks, setTasks] = createSignal<BackgroundTask[]>([task, { ...task, id: "b", name: "Reviewer" }]);
  const view = render(() => <BackgroundTasks tasks={tasks()} />);
  const outer = view.getByRole("button", { name: /Background agents & workflows/ });
  fireEvent.click(outer); flush();
  const scout = view.getByText("Scout").closest("li");
  fireEvent.click(outer); flush();
  setTasks([{ ...task, id: "b", name: "Reviewer", status: "error", error: "<img src=x onerror=fail()>" }, { ...task, status: "completed", result: "Fresh result" }]); flush();
  expect(outer.getAttribute("aria-expanded")).toBe("false");
  expect(view.getByRole("status").textContent).toContain("1 failed");
  expect(view.getByRole("status").textContent).not.toContain("queued / running");
  fireEvent.click(outer); flush();
  expect(view.getByText("Scout").closest("li")).toBe(scout);
  expect(view.getByText("Completed")).toBeTruthy();
  expect(view.getByText("Failed")).toBeTruthy();
  expect(view.getByText("<img src=x onerror=fail()>").closest("[hidden]")).toBeNull();
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.queryByText("Fresh result")).toBeNull();
});

test("empty background activity renders no disclosure", () => {
  const [tasks, setTasks] = createSignal<BackgroundTask[]>([]);
  const view = render(() => <BackgroundTasks tasks={tasks()} />);
  expect(view.container.textContent).toBe("");
  expect(view.queryByRole("button")).toBeNull();
  setTasks([task]); flush();
  expect(view.getByRole("button", { name: /Background agents & workflows/ }).getAttribute("aria-expanded")).toBe("false");
  setTasks([]); flush();
  expect(view.container.textContent).toBe("");
  expect(view.queryByRole("status")).toBeNull();
});

test("workflows have a distinct kind label but no result preview", () => {
  const workflow: BackgroundTask = { ...task, id: "wf_review", kind: "workflow", name: "Review changes", description: "Check correctness", status: "completed", result: "Review complete" };
  const view = render(() => <BackgroundTasks tasks={[task, workflow]} />);
  fireEvent.click(view.getByRole("button", { name: /Background agents & workflows/ })); flush();
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
  const view = render(() => <BackgroundTasks tasks={[{ ...task, kind: "workflow" }]} />);
  fireEvent.click(view.getByRole("button", { name: /Background agents & workflows/ })); flush();
  expect(view.getByText("Workflow phase progress is not available.")).toBeTruthy();
  expect(view.queryByRole("progressbar")).toBeNull();
});

test("all terminal states have explicit labels instead of being called completed", () => {
  const statuses: BackgroundStatus[] = ["completed", "steered", "error", "aborted", "stopped", "unknown"];
  const view = render(() => <BackgroundTasks tasks={statuses.map(status => ({ ...task, id: status, name: status, status, description: "" }))} />);
  fireEvent.click(view.getByRole("button", { name: /Background agents & workflows/ })); flush();
  for (const label of ["Completed", "Steered", "Failed", "Aborted", "Stopped", "Interrupted"]) expect(view.getByText(label)).toBeTruthy();
  expect(view.queryByText(/No result available/)).toBeNull();
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
