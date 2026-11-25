import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { CanvasNode, CanvasPlan, RecordedEvidence, ResponseCard, SimpleResponse } from "../generated/protocol";
import type { OpenCodeReference } from "../code-reference";
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

/** Renders validated semantic groups through the existing safe block renderer.
 * Groups preserve source order and stay expanded; only details cards collapse. */
function Composition(props: { node: CanvasNode; blocks: ResponseCard[]; renderBlock: (card: ResponseCard) => JSX.Element }) {
  const node = props.node;
  const block = (index: number) => {
    const card = props.blocks[index];
    return <div class="response-canvas-block" data-component={card.type}>{props.renderBlock(card)}</div>;
  };
  if (node.type === "block") return block(node.index);
  if (node.type === "comparison_panels") return <div class="response-comparison-panels" data-mode={node.mode}>
    <For each={[node.left, node.right]}>{side => <section class="response-comparison-panel" aria-label={side.title}>
      <h3>{side.title}</h3><div class="response-composition-stack"><For each={side.blocks}>{block}</For></div>
    </section>}</For>
  </div>;
  const children = () => <For each={node.children}>{child => <Composition node={child} blocks={props.blocks} renderBlock={props.renderBlock} />}</For>;
  if (node.type === "section") return <section class="response-composition-section"><h3>{node.title}</h3><div class="response-composition-stack">{children()}</div></section>;
  if (node.type === "columns") return <div class="response-composition-columns" data-ratio={node.ratio}>{children()}</div>;
  return <div class="response-composition-stack">{children()}</div>;
}

/** Uses a composition tree when present, or the saved reply's legacy recipe. */
export function ResponseCanvas(props: { response: SimpleResponse; plan: CanvasPlan; renderBlock: (card: ResponseCard) => JSX.Element; openCode?: OpenCodeReference }) {
  return <div class="response-canvas" data-layout={props.plan.layout}>
    <header class="response-canvas-header">
      <Show when={props.plan.headline?.trim()}>{headline => <h2 class="response-canvas-headline">{headline()}</h2>}</Show>
      <Show when={props.response.summary.trim() && props.response.summary.trim() !== props.plan.headline?.trim()}><div class="response-canvas-lead"><Markdown text={props.response.summary} complete allowArtifacts={false} openCode={props.openCode} /></div></Show>
    </header>
    <RecordedErrors recorded={props.response.recorded} />
    <Show when={props.plan.composition} fallback={<div class={`response-canvas-body${canvasBlocks(props.response).some(block => block.slot === "focus") ? " has-focus" : ""}${canvasBlocks(props.response).some(block => block.slot === "support") ? " has-support" : ""}`}><For each={canvasBlocks(props.response)}>{block => <div class={`response-canvas-block is-${block.slot}`} data-component={block.card.type}>
      {props.renderBlock(block.card)}
    </div>}</For></div>}>
      {node => <div class="response-composition"><Composition node={node()} blocks={props.response.blocks} renderBlock={props.renderBlock} /></div>}
    </Show>
  </div>;
}
