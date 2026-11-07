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

it("keeps search open and focused across successive filter updates", async () => {
  const [query, setQuery] = createSignal("");
  const change = vi.fn();
  const choices = [{ value: "latest", label: "Latest change" }, { value: "older", label: "Older change" }];
  render(() => <SelectField label="Commit" value="latest" change={change}
    options={[
      ...(!choices.some(option => option.value === "latest" && option.label.toLowerCase().includes(query().toLowerCase())) ? [{ value: "latest", label: "Selected: Latest change" }] : []),
      ...choices.filter(option => option.label.toLowerCase().includes(query().toLowerCase())),
    ]}
    search={{ value: query(), change: value => { setQuery(value); flush(); }, label: "Find a commit", placeholder: "Search commits" }} />);
  const trigger = screen.getByRole("button", { name: /^Commit / });
  trigger.focus(); fireEvent.keyDown(trigger, { key: "Enter" }); flush();
  const input = screen.getByRole("searchbox") as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(input));
  for (const value of ["o", "ol", "no match", "older", ""]) {
    fireEvent.keyDown(input, { key: value.at(-1) ?? "Backspace" });
    fireEvent.input(input, { target: { value } });
    fireEvent.keyUp(input, { key: value.at(-1) ?? "Backspace" }); flush();
    // Let the selection library reconcile the changed option collection.
    await new Promise(resolve => setTimeout(resolve, 0)); flush();
    expect(screen.getByRole("searchbox")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(input.value).toBe(value);
    expect(change).not.toHaveBeenCalled();
  }
  fireEvent.keyDown(input, { key: "ArrowDown" }); flush();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" }); flush();
  fireEvent.keyDown(document.activeElement!, { key: "Enter" }); flush();
  expect(change).toHaveBeenCalledWith("older");
  await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
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
