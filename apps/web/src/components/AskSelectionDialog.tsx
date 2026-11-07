import { Button } from "@kobalte/core/button";
import { For, Show, createMemo, createSignal } from "solid-js";
import { diffLines, reviewDraft, reviewQuestions, reviewQuestionPresets, type DiffLine, type ReviewFile, type ReviewQuestion, type ReviewRequest } from "../local-review";
import type { SessionModel } from "../session-model";
import { ActionDialog } from "./ActionDialog";
import { fileReviewCard } from "../review-cards";
import { Icon } from "./Icon";
import { ReviewCode } from "./ReviewDiffCard";

/** Captured diff context stays fixed while the user writes their question. */
export interface ReviewSelection {
  file: ReviewFile;
  target: ReviewRequest;
  /** Omitted when asking about the whole file. */
  lines?: readonly DiffLine[];
  question?: ReviewQuestion;
  returnFocus?: Element;
}

/** Submits the user’s request with file/line references, preserving the chat composer. */
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
  return <ActionDialog title={selection.lines ? "Ask Pi about selected lines" : "Ask Pi about file"} description="Pi answers in chat. Only your question and file/line references are sent; your draft, quote, and attachments stay separate."
    class="review-selection-dialog" returnFocus={selection.returnFocus} close={props.close}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!prepared().text || !props.model.canConfigure()) return;
      if (!props.model.submitReview(prepared().text)) { setError("Could not send. Check the connection and try again."); return; }
      props.model.reviewCards.remember(fileReviewCard(selection.file, selection.target, selection.lines));
      props.close(); props.conversation();
    }}>
      <div class="review-selection-context"><Icon name="code" /><strong>{selection.file.path}</strong><span>{selection.lines ? `${selection.lines.length} ${selection.lines.length === 1 ? "line" : "lines"}` : "Whole file"} · {selection.target.scope} snapshot</span></div>
      <div class="review-selection-preview" aria-label={selection.lines ? "Selected code" : "File changes"}><ReviewCode path={selection.file.path} lines={lines} /></div>
      <label for={`review-question-${props.model.id}`}>Your question</label>
      <textarea id={`review-question-${props.model.id}`} rows={3} placeholder={selection.lines ? "What would you like to understand about these lines?" : "What would you like to understand about this file?"} value={question()} onInput={event => { setQuestion(event.currentTarget.value); setError(""); }} />
      <div class="review-selection-suggestions" role="group" aria-label="Suggested questions"><For each={reviewQuestionPresets}>{preset =>
        <Button type="button" onClick={() => { setQuestion(reviewQuestions[preset.question]); setError(""); }}>{preset.label}</Button>
      }</For></div>
      <Show when={prepared().error || error()}><p class="review-warning" role="alert">{prepared().error || error()}</p></Show>
      <Show when={!props.model.canConfigure()}><p class="review-help" role="status">{props.model.online() ? "Wait for Pi to finish its current action before sending." : "Reconnect to send this question."}</p></Show>
      <div class="dialog-actions"><Button type="button" onClick={props.close}>Cancel</Button><Button type="submit" class="primary" disabled={!props.model.canConfigure() || !prepared().text}><Icon name="arrow" />Send to Pi</Button></div>
    </form>
  </ActionDialog>;
}
