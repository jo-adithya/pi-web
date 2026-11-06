import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { ReviewRows } from "../src/ReviewRows";

afterEach(cleanup);
it("opens the evidence page once and still permits manual pagination", () => {
  const [focus, setFocus] = createSignal<{ index: number; token: object }>();
  const page = render(() => <ReviewRows rows={Array.from({ length: 1001 }, (_, index) => index)} identity="file" jump={() => {}} focus={focus()}>{row => <div data-row={row}>row {row}</div>}</ReviewRows>);
  expect(page.container.querySelectorAll("[data-row]")).toHaveLength(500);
  setFocus({ index: 600, token: {} }); flush();
  expect(page.getByText("row 600")).toBeTruthy();
  expect(page.queryByText("row 0")).toBeNull();
  fireEvent.click(page.getAllByRole("button", { name: "Previous rows" })[0]); flush();
  expect(page.getByText("row 0")).toBeTruthy();
  setFocus({ index: 600, token: {} }); flush();
  expect(page.getByText("row 600")).toBeTruthy();
  fireEvent.click(page.getAllByRole("button", { name: "Next rows" })[0]); flush();
  expect(page.getByText("row 1000")).toBeTruthy();
  expect(page.container.querySelectorAll("[data-row]")).toHaveLength(1);
});
