import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { SelectField } from "../src/components/SelectField";

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

it("shows the empty-state placeholder while options arrive", () => {
  const page = render(() => <SelectField label="Base" value="" options={[]} placeholder="Loading branches…" change={() => {}} />);
  expect(page.getByRole("button", { name: /^Base / }).textContent).toContain("Loading branches…");
});

it("selects an empty-string option and returns focus after keyboard dismissal", async () => {
  const [value, setValue] = createSignal("custom");
  const page = render(() => <SelectField label="Model" value={value()} options={[{ value: "", label: "Same as chat" }, { value: "custom", label: "Custom" }]} change={setValue} />);
  flush(); const trigger = page.getByRole("button", { name: /^Model / }); trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" }); flush();
  fireEvent.keyDown(screen.getByRole("option", { name: "Same as chat" }), { key: "Enter" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(value()).toBe(""); expect(trigger.textContent).toContain("Same as chat");
  fireEvent.keyDown(trigger, { key: "Enter" }); flush();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(document.activeElement).toBe(trigger); expect(value()).toBe("");
});
