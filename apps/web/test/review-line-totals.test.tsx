import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { ReviewLineTotals } from "../src/components/ReviewLineTotals";

const stats = { added: 240, totalAdded: 1120, removed: 80, totalRemoved: 300, unavailableFiles: 0 };
afterEach(cleanup);

it("shows both breakdowns on hover and focus without replacing the filtered totals", async () => {
  const page = render(() => <ReviewLineTotals stats={stats} />); flush();
  const trigger = page.getByRole("button", { name: "About line totals" });
  expect(page.getAllByRole("button")).toHaveLength(1);
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" }); flush();
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("Shown counts exclude tests, generated files, lockfiles, and .md files.");
  const table = within(tooltip).getByRole("table", { name: "Line changes" });
  expect(within(table).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["Lines", "Shown", "Excluded", "Total"]);
  expect(within(within(table).getByRole("row", { name: "Added 240 880 1,120" })).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["240", "880", "1,120"]);
  expect(within(within(table).getByRole("row", { name: "Deleted 80 220 300" })).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["80", "220", "300"]);
  expect(page.getByText("+240 added")).toBeTruthy();
  expect(page.getByText("−80 deleted")).toBeTruthy();
  expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
  fireEvent.pointerLeave(trigger, { pointerType: "mouse" }); flush();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  trigger.focus(); flush();
  await screen.findByRole("tooltip");
  fireEvent.keyDown(trigger, { key: "Escape" }); flush();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});

it("supports tap toggling and outside dismissal", async () => {
  const page = render(() => <ReviewLineTotals stats={stats} />); flush();
  const trigger = page.getByRole("button", { name: "About line totals" });
  fireEvent.pointerDown(trigger, { pointerType: "touch" });
  fireEvent.pointerUp(trigger, { pointerType: "touch" });
  fireEvent.click(trigger); flush();
  await screen.findByRole("tooltip");
  fireEvent.click(trigger); flush();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  fireEvent.click(trigger); flush();
  await screen.findByRole("tooltip");
  // Kobalte defers the outside-pointer listener until after the opening event.
  await new Promise(resolve => setTimeout(resolve, 0));
  fireEvent.pointerDown(document.body, { pointerType: "touch" });
  fireEvent.click(document.body); flush();
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});

it("updates both open breakdowns with refreshed counts, including zero exclusions", async () => {
  const [value, setValue] = createSignal(stats);
  const page = render(() => <ReviewLineTotals stats={value()} />); flush();
  fireEvent.click(page.getByRole("button", { name: "About line totals" })); flush();
  await screen.findByRole("tooltip");
  setValue({ added: 0, totalAdded: 0, removed: 0, totalRemoved: 0, unavailableFiles: 0 }); flush();
  expect(page.getByText("+0 added")).toBeTruthy();
  expect(page.getByText("−0 deleted")).toBeTruthy();
  expect(screen.getByRole("row", { name: "Added 0 0 0" })).toBeTruthy();
  expect(screen.getByRole("row", { name: "Deleted 0 0 0" })).toBeTruthy();
});
