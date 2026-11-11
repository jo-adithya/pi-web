import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, flush, Show } from "solid-js";
import { CommandPalette, type PaletteCommand } from "../src/components/CommandPalette";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("filters, navigates, skips activation of unavailable actions, and handles empty results", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const run = vi.fn(), close = vi.fn();
  const commands: PaletteCommand[] = [
    { id: "new", label: "New conversation", detail: "Unavailable", disabled: true, run },
    { id: "changes", label: "Open Changes", detail: "Action", run },
    { id: "settings", label: "Open Settings", detail: "Action", run },
  ];
  render(() => <CommandPalette commands={commands} close={close} />);
  const input = screen.getByRole("combobox");
  fireEvent.keyDown(input, { key: "Enter" }); flush();
  expect(run).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "ArrowDown" }); flush();
  expect(screen.getByRole("option", { name: "Open Changes Action" }).getAttribute("aria-selected")).toBe("true");
  expect(input.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Open Changes Action" }).id);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true }); flush();
  expect(run).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" }); flush();
  expect(run).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(input, { key: "ArrowUp" }); flush();
  fireEvent.keyDown(input, { key: "ArrowUp" }); flush();
  expect(screen.getByRole("option", { name: "Open Settings Action" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.input(input, { target: { value: "NO MATCH" } }); flush();
  expect(screen.getByRole("status").textContent).toContain("No matching");
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" }); flush();
  expect(run).toHaveBeenCalledTimes(1);
  fireEvent.input(input, { target: { value: " SETTINGS " } }); flush();
  fireEvent.click(screen.getByRole("option", { name: "Open Settings Action" })); flush();
  expect(run).toHaveBeenCalledTimes(2);
});

it("focuses search, traps Tab, and restores the trigger after Escape", async () => {
  render(() => {
    const [open, setOpen] = createSignal(false);
    return <><button onClick={() => setOpen(true)}>Launch palette</button><Show when={open()}><CommandPalette commands={[]} close={() => setOpen(false)} /></Show></>;
  });
  const trigger = screen.getByRole("button", { name: "Launch palette" });
  trigger.focus(); fireEvent.click(trigger); flush();
  await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab", shiftKey: true }); flush();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close Esc" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" }); flush();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.queryByRole("dialog")).toBeNull();
});
