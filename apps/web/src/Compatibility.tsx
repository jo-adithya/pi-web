import { createStore } from "solid-js";
import type { ProcessStatus } from "./generated/protocol";

/** M0 compiler/store fixture. The status is simulated; no Pi process is connected. */
export default function App() {
  const [state, setState] = createStore<{ process: ProcessStatus }>({
    process: "starting",
  });

  return (
    <main>
      <h1>Pi Web</h1>
      <p>Compatibility fixture — no agent connected.</p>
      <p role="status">{state.process}</p>
      <button type="button" onClick={() => setState((draft) => { draft.process = "ready"; })}>
        Test staged update
      </button>
    </main>
  );
}
