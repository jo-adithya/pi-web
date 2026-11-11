import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { CanvasPlan, RecordedEvidence, ResponseCard, SimpleResponse } from "../generated/protocol";
import type { CodeLocation } from "../code-reference";
import { canvasBlocks } from "../response-plan";
import { Markdown } from "./Markdown";
import "./response-canvas.css";

/** Keeps observed errors and trace limits visible even when their evidence block is omitted. */
export function RecordedErrors(props: { recorded?: RecordedEvidence }) {
  const errors = () => props.recorded?.tools.filter(tool => tool.outcome === "error").length ?? 0;
  return <><Show when={errors()}><aside class="response-recorded-errors" aria-label="Observed tool errors">
    <strong>{errors()} tool {errors() === 1 ? "error" : "errors"} during work</strong>
    <span>May include recovered errors; this is not a final test verdict.</span>
  </aside></Show><Show when={props.recorded?.omittedTools}><p class="response-provenance">Only the latest tool observations were kept; recorded error counts may be incomplete.</p></Show></>;
}

const LABELS = { answer: "Answer", result: "Result", explanation: "How it works", investigation: "Investigation", review: "Review", plan: "Plan", comparison: "Comparison" };

/** Composes a completed answer around its selected primary visual, with explicit risk
 * and evidence areas. The caller supplies the safe component renderer. */
export function ResponseCanvas(props: { response: SimpleResponse; plan: CanvasPlan; renderBlock: (card: ResponseCard) => JSX.Element; openCode?: (location: CodeLocation) => void }) {
  return <div class="response-canvas" data-layout={props.plan.layout}>
    <header class="response-canvas-header">
      <span class="response-canvas-label">{LABELS[props.plan.layout]}</span>
      <h2 class="response-canvas-headline">{props.plan.headline}</h2>
      <Show when={props.response.summary.trim() !== props.plan.headline.trim()}><div class="response-canvas-lead"><Markdown text={props.response.summary} complete allowArtifacts={false} openCode={props.openCode} /></div></Show>
    </header>
    <RecordedErrors recorded={props.response.recorded} />
    <div class={`response-canvas-body${canvasBlocks(props.response).some(block => block.slot === "focus") ? " has-focus" : ""}${canvasBlocks(props.response).some(block => block.slot === "support") ? " has-support" : ""}`}><For each={canvasBlocks(props.response)}>{block => <div class={`response-canvas-block is-${block.slot}`} data-component={block.card.type}>
      {props.renderBlock(block.card)}
    </div>}</For></div>
  </div>;
}
