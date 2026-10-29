import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createStore, flush, onSettled } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import App from "../src/Compatibility";
import type { SessionDescriptor } from "../src/generated/protocol";
import sessionFixture from "../../../fixtures/protocol/session.json";

afterEach(cleanup);

test("renders Rust-typed status and commits staged store updates", () => {
  const view = render(() => <App />);
  const status = view.getByRole("status");
  expect(status.textContent).toBe("starting");
  fireEvent.click(view.getByRole("button", { name: "Test staged update" }));
  flush();
  expect(status.textContent).toBe("ready");
});

test("keeps separately owned stores isolated", () => {
  const view = render(() => <><App /><App /></>);
  const buttons = view.getAllByRole("button");
  fireEvent.click(buttons[0]);
  flush();
  expect(view.getAllByRole("status").map((node) => node.textContent))
    .toEqual(["ready", "starting"]);
});

test("releases owned subscriptions on unmount", () => {
  const released = vi.fn();
  function Owner() {
    onSettled(() => released);
    return <p>Owned fixture</p>;
  }
  const view = render(() => <Owner />);
  flush();
  expect(released).not.toHaveBeenCalled();
  view.unmount();
  expect(released).toHaveBeenCalledOnce();
});

test("ordinary writes remain staged until flushed", () => {
  let observe: () => void = () => { throw new Error("fixture did not mount"); };
  function Owner() {
    const [state, setState] = createStore({ count: 0 });
    observe = () => {
      setState((draft) => { draft.count = 1; });
      expect(state.count).toBe(0);
      flush();
      expect(state.count).toBe(1);
    };
    return <p>{state.count}</p>;
  }
  render(() => <Owner />);
  observe();
});

test("shared JSON fixture matches the generated declaration", () => {
  // JSON imports widen string literals. Narrow the enum value before assignment.
  expect(sessionFixture.process).toBe("starting");
  if (sessionFixture.process !== "starting") throw new Error("invalid fixture status");
  const session: SessionDescriptor = { ...sessionFixture, process: sessionFixture.process };
  expect(Object.keys(session).sort()).toEqual(["epoch", "process", "sessionId"]);
});
