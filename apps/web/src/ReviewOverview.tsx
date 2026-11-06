import { Button } from "@kobalte/core/button";
import { Collapsible } from "@kobalte/core/collapsible";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ReviewEntry } from "./local-review";
import type { IntentGroup } from "./review-groups";
import { ReviewExplanation } from "./ReviewExplanation";
import type { EvidenceCitation, ExplanationEvidence, ReviewExplanations } from "./review-explanations";

/** Filename-based review prompts. These are navigation hints, not findings about code behavior. */
const checkpoints = [
  { title: "Access and trust", matches: /(^|[/_.-])(auth\w*|session\w*|permission\w*|token\w*|security)([/_.-]|$)/i, question: "Who can reach this behavior? Check permission checks, rejected input, and sensitive data." },
  { title: "Stored data", matches: /(^|[/_.-])(migration\w*|schema\w*|database\w*|storage|persist\w*)([/_.-]|$)/i, question: "What happens to existing data? Check compatibility, failure recovery, and rollback." },
  { title: "Dependencies and delivery", matches: /(^|\/)(package\.json|[^/]*lock[^/]*|cargo\.toml|dockerfile[^/]*|\.github\/workflows\/.*)$/i, question: "Check dependency changes, build permissions, and deployment compatibility." },
];
const testPath = /(^|\/)(__tests__|tests?|specs?|e2e)(\/|$)|[._-](test|spec)[._-]|(^|\/)test_[^/]+$/i;

/** A bounded, expandable list of exact snapshot paths; opening a path delegates to the diff browser. */
function EvidenceFiles(props: { paths: string[]; open: (path: string) => void }) {
  const [expanded, setExpanded] = createSignal(false);
  return <><ul class="review-evidence-files"><For each={expanded() ? props.paths : props.paths.slice(0, 8)}>{path =>
    <li><Button type="button" title={`Open diff for ${path}`} onClick={() => props.open(path)}>{path}</Button></li>
  }</For></ul><Show when={!expanded() && props.paths.length > 8}><Button type="button" onClick={() => setExpanded(true)}>Show all {props.paths.length} files</Button></Show></>;
}

/** Snapshot-linked orientation using existing AI explanations and explicitly labelled filename hints.
 * Opening evidence never sends a prompt or marks a file reviewed. Test execution results are not supplied.
 */
export function ReviewOverview(props: {
  files: ReviewEntry[];
  groups: IntentGroup[] | undefined;
  reviewed: (file: ReviewEntry) => boolean;
  open: (path: string) => void;
  startGroup: (paths: string[]) => void;
  explanations?: ReviewExplanations;
  openEvidence?: (citation: EvidenceCitation, evidence: ExplanationEvidence) => void;
  explanationDisabled?: boolean;
}) {
  const reviewedPaths = createMemo(() => new Set(props.files.filter(props.reviewed).map(file => file.path)));
  const tests = createMemo(() => props.files.filter(file => testPath.test(file.path)));
  const checks = createMemo(() => checkpoints.map(check => ({ ...check, paths: props.files.filter(file => check.matches.test(file.path)).map(file => file.path) })).filter(check => check.paths.length));
  return <section class="review-overview" aria-label="Change overview">
    <section class="review-overview-purpose" aria-labelledby="review-purpose-heading">
      <h2 id="review-purpose-heading">Suggested groups</h2>
      <Show when={props.groups} fallback={<p>Group related changes with AI. Use <strong>Group with AI</strong> above.</p>}>
        <p>AI-suggested groups use limited diff context—not a correctness review or traced call graph.</p>
        <ol class="review-overview-steps" aria-label="Suggested review order"><For each={props.groups}>{group => <li>
          <div class="review-overview-step-heading"><h3>{group.title}</h3><span>{group.paths.filter(path => reviewedPaths().has(path)).length}/{group.paths.length} reviewed</span></div>
          <p>{group.reason}</p>
          <Button type="button" onClick={() => props.startGroup(group.paths)}>Review {group.title}</Button>
          <Show when={props.explanations && props.openEvidence}><ReviewExplanation group={group} model={props.explanations!} open={props.openEvidence!} disabled={props.explanationDisabled ?? false} /></Show>
          <EvidenceFiles paths={group.paths} open={props.open} />
        </li>}</For></ol>
      </Show>
    </section>
    <Show when={props.explanations?.error()}><p class="review-warning" role="alert">{props.explanations!.error()}</p></Show>
    <div class="review-overview-checks">
      <section aria-labelledby="review-risk-heading">
        <h2 id="review-risk-heading">Review checkpoints</h2>
        <p>Filename hints, not a security assessment. Other risks may exist in any file.</p>
        <For each={checks()} fallback={<p>No filename matches. Check behavior, error paths, and compatibility.</p>}>{check => <div class="review-checkpoint">
          <h3>{check.title}</h3><p>{check.question}</p><EvidenceFiles paths={check.paths} open={props.open} />
        </div>}</For>
      </section>
      <section aria-labelledby="review-tests-heading">
        <h2 id="review-tests-heading">Changed tests</h2>
        <p>Tests are not run here; changed filenames do not establish coverage or passing results.</p>
        <Show when={tests().length} fallback={<p>No changed test files recognized by filename. Tests may be unchanged or live elsewhere.</p>}>
          <h3>{tests().length} changed test {tests().length === 1 ? "file" : "files"}</h3>
          <EvidenceFiles paths={tests().map(file => file.path)} open={props.open} />
          <p>Check assertions, failures, and edge cases. Deleted tests may remove coverage.</p>
        </Show>
      </section>
    </div>
    <Collapsible class="review-overview-all"><Collapsible.Trigger>All {props.files.length} changed files</Collapsible.Trigger><Collapsible.Content><EvidenceFiles paths={props.files.map(file => file.path)} open={props.open} /></Collapsible.Content></Collapsible>
  </section>;
}
