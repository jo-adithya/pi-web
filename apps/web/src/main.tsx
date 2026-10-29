import { render } from "@solidjs/web";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const dispose = render(() => <App />, root);
if (import.meta.hot) import.meta.hot.dispose(dispose);
