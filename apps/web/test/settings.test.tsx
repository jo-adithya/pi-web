import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { SettingsPage, type GroupingPreferences } from "../src/SettingsPage";
import { createSessionModel } from "../src/session-model";
import type { GroupOptions } from "../src/review-costs";

const cheap = { provider: "test", id: "small", name: "Small", images: false };
function session(id: string) {
  const model = createSessionModel(id, () => true, () => true);
  model.receive({ v: 1, sessionId: id, epoch: "epoch", body: { type: "hello", project: "fixture", process: "ready" } });
  model.receive({ v: 1, sessionId: id, epoch: "epoch", body: { type: "settings", settings: { models: [cheap], model: cheap, thinkingLevel: "off", thinkingLevels: ["off"], codexFast: null } } });
  return model;
}
/** Models server-confirmed settings; transport and persistence are covered by App/server tests. */
function preferences() {
  const [options, update] = createSignal<GroupOptions>({ maxCalls: 6, maxRequestBytes: 512 * 1024, includeGenerated: false });
  const [disabled, setDisabled] = createSignal(false);
  const setOptions = vi.fn((next: GroupOptions) => { update(next); flush(); });
  const grouping: GroupingPreferences = { options, setOptions, disabled, status: () => disabled() ? "Saving settings…" : "Saved on this server." };
  return { grouping, update, setDisabled, setOptions };
}
beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("opens appearance choices from the shared picker and dismisses with Escape without changing the value", async () => {
  const theme = vi.fn();
  const page = render(() => <SettingsPage theme="system" setTheme={theme} />);
  flush();
  const picker = page.getByRole("button", { name: /^Color scheme / });
  fireEvent.keyDown(picker, { key: "Enter" }); flush();
  expect(screen.getByRole("option", { name: "Dark" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(theme).not.toHaveBeenCalled();
});

it("shares review preferences across conversations and changes appearance through its owner", async () => {
  const one = session("one"), two = session("two"), theme = vi.fn();
  const prefs = preferences();
  const [model, setModel] = createSignal(one);
  const page = render(() => <SettingsPage model={model()} grouping={prefs.grouping} theme="system" setTheme={theme} />);
  flush();
  await chooseOption("Grouping model", "Small · test");
  fireEvent.change(page.getByLabelText("Maximum AI calls"), { target: { value: "3" } }); flush();
  await chooseOption("Total request limit", "128 KiB");
  fireEvent.click(page.getByLabelText("Include generated / lockfile contents")); flush();
  expect(prefs.grouping.options()).toEqual({ model: { provider: "test", id: "small" }, maxCalls: 3, maxRequestBytes: 128 * 1024, includeGenerated: true });
  setModel(two); flush();
  expect((page.getByLabelText("Maximum AI calls") as HTMLInputElement).value).toBe("3");
  expect(page.getByRole("button", { name: /^Grouping model / }).textContent).toContain("Small · test");
  await chooseOption("Color scheme", "Dark");
  expect(theme).toHaveBeenCalledWith("dark");
});

it("can edit global limits without selecting a conversation and reflects remote updates", () => {
  const prefs = preferences();
  const page = render(() => <SettingsPage grouping={prefs.grouping} theme="system" setTheme={() => {}} />);
  fireEvent.change(page.getByLabelText("Maximum AI calls"), { target: { value: "4" } }); flush();
  expect(prefs.setOptions).toHaveBeenCalledWith(expect.objectContaining({ maxCalls: 4 }));
  prefs.update({ maxCalls: 9, maxRequestBytes: 128 * 1024, includeGenerated: true }); flush();
  expect((page.getByLabelText("Maximum AI calls") as HTMLInputElement).value).toBe("9");
  expect((page.getByLabelText("Include generated / lockfile contents") as HTMLInputElement).checked).toBe(true);
});

it.each(["", "0", "101", "1.5"])("keeps the last valid call limit for invalid input %s", value => {
  const prefs = preferences();
  const page = render(() => <SettingsPage grouping={prefs.grouping} theme="system" setTheme={() => {}} />);
  fireEvent.change(page.getByLabelText("Maximum AI calls"), { target: { value } }); flush();
  expect(prefs.grouping.options().maxCalls).toBe(6);
  expect(page.getByLabelText("Maximum AI calls").getAttribute("aria-invalid")).toBe("true");
  expect(prefs.setOptions).not.toHaveBeenCalled();
  fireEvent.change(page.getByLabelText("Maximum AI calls"), { target: { value: "100" } }); flush();
  expect(prefs.grouping.options().maxCalls).toBe(100);
  expect(page.getByLabelText("Maximum AI calls").getAttribute("aria-invalid")).toBe("false");
});

it("locks controls only while saving or disconnected, not while grouping runs", async () => {
  const model = session("busy"), prefs = preferences();
  const run = model.review.grouping.run(signal => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }))); flush();
  const page = render(() => <SettingsPage model={model} grouping={prefs.grouping} theme="system" setTheme={() => {}} />);
  expect((page.getByRole("button", { name: /^Grouping model / }) as HTMLButtonElement).disabled).toBe(false);
  prefs.setDisabled(true); flush();
  expect((page.getByRole("button", { name: /^Grouping model / }) as HTMLButtonElement).disabled).toBe(true);
  expect(page.getByRole("status").textContent).toContain("Saving");
  prefs.setDisabled(false); flush();
  expect((page.getByRole("button", { name: /^Grouping model / }) as HTMLButtonElement).disabled).toBe(false);
  model.review.grouping.cancel(); await run;
});

it("shows an unavailable selected model instead of implying Same as chat", async () => {
  const model = session("unavailable"), prefs = preferences();
  prefs.update({ ...prefs.grouping.options(), model: { provider: "other", id: "removed" } }); flush();
  const page = render(() => <SettingsPage model={model} grouping={prefs.grouping} theme="system" setTheme={() => {}} />);
  expect(page.getByRole("button", { name: /^Grouping model / }).textContent).toContain("currently unavailable");
  await chooseOption("Grouping model", "Same as chat (Small)");
  expect(prefs.grouping.options().model).toBeUndefined();
});

async function chooseOption(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: new RegExp(`^${label} `) }), { key: "Enter" }); flush();
  fireEvent.keyDown(screen.getByRole("option", { name: option }), { key: "Enter" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
