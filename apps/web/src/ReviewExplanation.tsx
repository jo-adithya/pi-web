import { Button } from "@kobalte/core/button";
import { createSignal, For, Show } from "solid-js";
import type { IntentGroup } from "./review-groups";
import type { EvidenceCitation, ExplanationEvidence, ReviewExplanations } from "./review-explanations";
import { groupingUsageLabel } from "./review-costs";

/** Explicitly requested interpretations with validated diff links, never a correctness verdict. */
export function ReviewExplanation(props: { group: IntentGroup; model: ReviewExplanations; open: (citation: EvidenceCitation, evidence: ExplanationEvidence) => void; disabled: boolean }) {
  const [expanded, setExpanded] = createSignal(false);
  const result = () => props.model.result(props.group);
  const busy = () => props.model.busy() === props.model.key(props.group);
  return <section class="review-explanation" aria-label={`Explanation for ${props.group.title}`}>
    <Button type="button" disabled={props.disabled || !!props.model.busy()} aria-expanded={expanded() && !!result() ? "true" : "false"} onClick={() => {
      if (result()) setExpanded(!expanded());
      else { setExpanded(true); void props.model.explain(props.group); }
    }}>{busy() ? "Explaining…" : result() ? expanded() ? "Hide explanation" : "Show explanation" : "Explain this group"}</Button>
    <Show when={busy()}><Button type="button" onClick={props.model.cancel}>Cancel explanation</Button></Show>
    <Show when={expanded() && result()}>{answer => <div>
      <p class="review-explanation-note">AI interpretation—not verified facts. Links prove the cited lines were supplied, not that the claim is correct.</p>
      <p class="review-explanation-note">Diff evidence: {answer().supplied}/{answer().total} files{answer().sampled ? " · excerpts truncated" : ""}. One AI call per explanation; reopening saved evidence makes no new call.</p>
      <For each={[["observations", "What changed"], ["inferences", "Likely intent · inference"], ["risks", "What could break · possibilities"]] as const}>{([kind, title]) => <Show when={answer().value[kind].length}>
        <h4>{title}</h4><ul><For each={answer().value[kind]}>{statement => <li><p>{statement.text}</p><div class="review-evidence-links"><For each={statement.citations}>{citation =>
          <Button type="button" title="Open these captured diff lines; reject the link if the file changed" onClick={() => props.open(citation, answer().evidence.get(citation.path)!)}>{citation.path} · diff {citation.startLine}{citation.endLine !== citation.startLine ? `–${citation.endLine}` : ""}</Button>
        }</For></div></li>}</For></ul>
      </Show>}</For>
      <Show when={answer().value.limitations.length}><h4>Limits and unknowns</h4><ul><For each={answer().value.limitations}>{limit => <li>{limit}</li>}</For></ul></Show>
      <p class="review-explanation-note" aria-label="Explanation usage">{groupingUsageLabel(answer().usage)}</p>
    </div>}</Show>
  </section>;
}
