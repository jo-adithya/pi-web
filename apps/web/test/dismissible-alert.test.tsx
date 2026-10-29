import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { DismissibleAlert } from "../src/components/DismissibleAlert";

afterEach(cleanup);

it("keeps a dismissed warning hidden but shows changed and cleared-then-repeated warnings", async () => {
  const [message, setMessage] = createSignal<string | null | undefined>("Warning A");
  const view = render(() => <DismissibleAlert message={message()} class="warning" role="alert" />);
  flush();
  expect(view.getByRole("alert").textContent).toBe("Warning A");
  await fireEvent.click(view.getByRole("button", { name: "Dismiss warning" })); flush();
  expect(view.queryByRole("alert")).toBeNull();
  setMessage("Warning A"); flush();
  expect(view.queryByRole("alert")).toBeNull();
  setMessage("Warning B"); flush();
  expect(view.getByRole("alert").textContent).toBe("Warning B");
  await fireEvent.click(view.getByRole("button", { name: "Dismiss warning" })); flush();
  for (const empty of [null, undefined, ""]) {
    setMessage(empty); flush();
    expect(view.queryByRole("alert")).toBeNull();
    setMessage("Warning B"); flush();
    expect(view.getByRole("alert").textContent).toBe("Warning B");
    await fireEvent.click(view.getByRole("button", { name: "Dismiss warning" })); flush();
  }
});
