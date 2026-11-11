import { Button } from "@kobalte/core/button";
import { For, Show, createMemo, createSignal } from "solid-js";
import { diffLines, reviewDraft, reviewQuestions, reviewQuestionPresets, type DiffLine, type ReviewFile, type ReviewQuestion, type ReviewRequest } from "../local-review";
import type { SessionModel } from "../session-model";
import { ActionDialog } from "./ActionDialog";
import { fileReviewCard } from "../review-cards";
import { Icon } from "./Icon";
import { ReviewContextPreview } from "./ReviewContextPreview";

/** Captured diff context stays fixed while the user writes their question. */
export interface ReviewSelection {
  file: ReviewFile;
  target: ReviewRequest;
  /** Omitted when asking about the whole file. */
  lines?: readonly DiffLine[];
  question?: ReviewQuestion;
  returnFocus?: Element;
}

/** Prepares a scoped question for immediate sending or a collected feedback batch, preserving the chat composer. */
export function AskSelectionDialog(props: { selection: ReviewSelection; model: SessionModel; close: () => void; conversation: () => void }) {
  const selection = props.selection;
  const [question, setQuestion] = createSignal(selection.question ? reviewQuestions[selection.question] : "");
  const [error, setError] = createSignal("");
  const prepared = createMemo(() => {
    if (!question().trim()) return { text: "", error: "" };
    try {
      return { text: reviewDraft(question().trim(), selection.file, selection.target, selection.lines), error: "" };
    } catch (error) { return { text: "", error: error instanceof Error ? error.message : "Could not prepare this question." }; }
  });
  const lines = selection.lines ?? diffLines(selection.file.patch);
  const scope = { unstaged: "Unstaged", staged: "Staged", branch: "Branch", commit: "Commit", turn: "Last turn" }[selection.target.scope];
  return <ActionDialog title={selection.lines ? "Ask Pi about selected lines" : "Ask Pi about file"} description="Ask a question or collect feedback to send together."
    class="review-selection-dialog" returnFocus={selection.returnFocus} close={props.close}>
    <form class="review-selection-form" onSubmit={event => {
      event.preventDefault();
      if (!prepared().text || !props.model.canConfigure()) return;
      if (!props.model.submitReview(prepared().text)) { setError("Could not send. Check the connection and try again."); return; }
      props.model.reviewCards.remember(fileReviewCard(selection.file, selection.target, selection.lines));
      props.close(); props.conversation();
    }}>
      <div class="review-selection-body">
        <div class="review-selection-snapshot">
          <div class="review-selection-context"><Icon name="code" /><div><strong>{selection.file.path}</strong><span>{selection.lines ? `${selection.lines.length} selected ${selection.lines.length === 1 ? "line" : "lines"}` : "Whole file"} · {scope} snapshot</span></div></div>
          <ReviewContextPreview path={selection.file.path} lines={lines} label={selection.lines ? "Selected code" : "File changes"} />
        </div>
        <div class="review-selection-editor">
          <label for={`review-question-${props.model.id}`}>Your question</label>
          <textarea id={`review-question-${props.model.id}`} rows={3} placeholder="Ask a question, flag a risk, or suggest a change…" value={question()} onInput={event => { setQuestion(event.currentTarget.value); setError(""); }} />
          <div class="review-selection-suggestions" role="group" aria-label="Suggested questions"><span aria-hidden="true">Quick prompts</span><For each={reviewQuestionPresets}>{preset =>
            <Button type="button" onClick={() => { setQuestion(reviewQuestions[preset.question]); setError(""); }}>{preset.label}</Button>
          }</For></div>
        </div>
        <Show when={prepared().error || error()}><p class="review-warning" role="alert">{prepared().error || error()}</p></Show>
        <Show when={!props.model.canConfigure()}><p class="review-help" role="status">{props.model.online() ? "Send now is available when Pi is ready. You can still collect feedback." : "Reconnect to send. You can still collect feedback."}</p></Show>
        <p class="review-selection-privacy"><Icon name="info" />Only your note and file/line references are sent.</p>
      </div>
      <footer class="review-selection-footer">
        <div class="review-selection-actions">
          <div><Button type="button" class="review-selection-collect" aria-describedby={`review-collect-${props.model.id}`} disabled={!prepared().text} onClick={() => {
            if (props.model.addFeedback(question().trim(), fileReviewCard(selection.file, selection.target, selection.lines))) props.close();
            else setError("Feedback is full. Send or remove some notes before adding more.");
          }}><Icon name="plus" />Add feedback</Button><span id={`review-collect-${props.model.id}`}>Send together from Changes.</span></div>
          <div><Button type="submit" class="primary" aria-describedby={`review-send-${props.model.id}`} disabled={!props.model.canConfigure() || !prepared().text}><Icon name="arrow" />Send to Pi</Button><span id={`review-send-${props.model.id}`}>Send this note now.</span></div>
        </div>
        <div class="review-selection-footer-meta"><Button type="button" onClick={props.close}>Cancel</Button><span aria-live="polite"><Show when={props.model.feedback().length} fallback="Your chat draft stays separate.">{props.model.feedback().length} {props.model.feedback().length === 1 ? "note" : "notes"} collected</Show></span></div>
      </footer>
    </form>
  </ActionDialog>;
}
