import { Button } from "@kobalte/core/button";
import { Show, createSignal } from "solid-js";
import type { FeedbackNote } from "../session-draft";
import type { SessionModel } from "../session-model";
import { ActionDialog } from "./ActionDialog";
import { Icon } from "./Icon";
import { ReviewContextPreview } from "./ReviewContextPreview";

/** Edits a collected comment against its original captured source; saving never sends a request. */
export function FeedbackNoteDialog(props: { note: FeedbackNote; model: SessionModel; close: () => void }) {
  const [comment, setComment] = createSignal(props.note.comment);
  const [error, setError] = createSignal("");
  const file = props.note.card.files[0];
  return <ActionDialog title="Edit feedback" description="Update your note. Its captured code and references stay the same." class="review-selection-dialog" close={props.close}>
    <form class="review-selection-form" onSubmit={event => {
      event.preventDefault();
      if (props.model.editFeedback(props.note.id, comment())) props.close();
      else setError("Could not save. Shorten the note, or wait for the current request to finish.");
    }}>
      <div class="review-selection-body">
        <Show when={file}><div class="review-selection-snapshot">
          <div class="review-selection-context"><Icon name="code" /><div><strong>{file.path}</strong><span>Captured preview · may differ from current files</span></div></div>
          <Show when={file.lines} fallback={<p class="review-help">No captured code is available.</p>}>{lines => <ReviewContextPreview path={file.path} lines={lines()} label="Captured code" />}</Show>
        </div></Show>
        <div class="review-selection-editor"><label for={`feedback-${props.note.id}`}>Feedback</label><textarea id={`feedback-${props.note.id}`} rows={3} value={comment()} onInput={event => { setComment(event.currentTarget.value); setError(""); }} /></div>
        <Show when={error()}><p class="review-warning" role="alert">{error()}</p></Show>
      </div>
      <div class="review-selection-footer"><div class="dialog-actions"><Button type="button" onClick={props.close}>Cancel</Button><Button type="submit" class="primary" disabled={!comment().trim() || props.model.pending()}>Save note</Button></div><p class="review-help">Saved to your collected feedback, not sent to Pi.</p></div>
    </form>
  </ActionDialog>;
}
