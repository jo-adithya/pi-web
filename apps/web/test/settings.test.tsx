import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { SettingsPage } from "../src/SettingsPage";
import { createSessionModel } from "../src/session-model";

const cheap = { provider: "test", id: "small", name: "Small", images: false };
function session(id: string) {
  const model = createSessionModel(id, () => true, () => true);
  model.receive({ v: 1, sessionId: id, epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: id, epoch: "epoch", body: { type: "settings", settings: { models: [cheap], model: cheap, thinkingLevel: "off", thinkingLevels: ["off"], codexFast: null } } });
  return model;
}
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("opens appearance choices from the shared picker and dismisses with Escape without changing the value", async () => {
  const theme = vi.fn();
  const page = render(() => <SettingsPage conversation="" theme="system" setTheme={theme} />);
  flush();
  const picker = page.getByRole("button", { name: /^Color scheme / });
  fireEvent.keyDown(picker, { key: "Enter" }); flush();
  expect(screen.getByRole("option", { name: "Dark" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(theme).not.toHaveBeenCalled();
});

it("keeps review preferences with their conversation and changes appearance through its owner", async () => {
  const one = session("one"), two = session("two"), fetcher = vi.fn(), theme = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const [model, setModel] = createSignal(one);
  const page = render(() => <SettingsPage model={model()} conversation={model().id} theme="system" setTheme={theme} />);
  flush();
  await chooseOption("Grouping model", "Small · test");
  fireEvent.change(page.getByLabelText("Maximum AI calls"), { target: { value: "3" } }); flush();
  await chooseOption("Total request limit", "128 KiB");
  fireEvent.click(page.getByLabelText("Include generated / lockfile contents")); flush();
  expect(one.review.grouping.options()).toEqual({ model: { provider: "test", id: "small" }, maxCalls: 3, maxRequestBytes: 128 * 1024, includeGenerated: true });
  setModel(two); flush();
  expect((page.getByLabelText("Maximum AI calls") as HTMLInputElement).value).toBe("6");
  expect(page.getByRole("button", { name: /^Grouping model / }).textContent).toContain("Same as chat");
  setModel(one); flush();
  expect((page.getByLabelText("Maximum AI calls") as HTMLInputElement).value).toBe("3");
  await chooseOption("Color scheme", "Dark");
  expect(theme).toHaveBeenCalledWith("dark");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["", "0", "101", "1.5"])("keeps the last valid call limit for invalid input %s", value => {
  const model = session("limits");
  const page = render(() => <SettingsPage model={model} conversation="Limits" theme="system" setTheme={() => {}} />);
  fireEvent.change(page.getByLabelText("Maximum AI calls"), { target: { value } }); flush();
  expect(model.review.grouping.options().maxCalls).toBe(6);
  expect(page.getByLabelText("Maximum AI calls").getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(page.getByLabelText("Maximum AI calls"), { target: { value: "100" } }); flush();
  expect(model.review.grouping.options().maxCalls).toBe(100);
  expect(page.getByLabelText("Maximum AI calls").getAttribute("aria-invalid")).toBe("false");
});

it("locks controls while grouping is running and unlocks after cancellation", async () => {
  const model = session("busy");
  const run = model.review.grouping.run(signal => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }))); flush();
  const page = render(() => <SettingsPage model={model} conversation="Busy" theme="system" setTheme={() => {}} />);
  expect((page.getByRole("button", { name: /^Grouping model / }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(page.getByRole("button", { name: /^Grouping model / }), { key: "Enter" }); flush();
  expect(page.queryByRole("listbox")).toBeNull();
  expect(page.getByRole("status").textContent).toContain("Grouping is running");
  model.review.grouping.cancel(); flush();
  expect((page.getByRole("button", { name: /^Grouping model / }) as HTMLButtonElement).disabled).toBe(false);
  await run;
});

it("shows an unavailable selected model instead of implying Same as chat", async () => {
  const model = session("unavailable");
  model.review.grouping.setOptions({ ...model.review.grouping.options(), model: { provider: "other", id: "removed" } });
  const page = render(() => <SettingsPage model={model} conversation="Unavailable" theme="system" setTheme={() => {}} />);
  expect(page.getByRole("button", { name: /^Grouping model / }).textContent).toContain("currently unavailable");
  await chooseOption("Grouping model", "Same as chat (Small)");
  expect(model.review.grouping.options().model).toBeUndefined();
});

async function chooseOption(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: new RegExp(`^${label} `) }), { key: "Enter" }); flush();
  fireEvent.keyDown(screen.getByRole("option", { name: option }), { key: "Enter" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
