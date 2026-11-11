import { validCard, type ReviewCard } from "./review-cards";
import type { ReplyQuote } from "./reply-quote";

/** A user comment and its fixed browser-only diff context. */
export interface FeedbackNote { id: string; comment: string; card: ReviewCard }
export interface PromptDraft { text: string; quote?: ReplyQuote; uncertain: boolean }
export interface FeedbackDraft { notes: FeedbackNote[]; uncertain: boolean }
const bytes = (text: string) => new TextEncoder().encode(text).length;
const promptKey = (id: string) => `pi-web:prompt-draft:v1:${id}`;
const feedbackKey = (id: string) => `pi-web:feedback-draft:v1:${id}`;

/** Formats only user comments and references; captured source stays in the browser. */
export const feedbackText = (notes: readonly FeedbackNote[]) => notes.map(note => `${note.comment}\n\n${note.card.reference}`).join("\n\n---\n\n");
/** Enforces 32 notes, 32 KiB of request text and 1 MiB of captured previews per batch. */
export function feedbackFits(notes: readonly FeedbackNote[]): boolean {
  return notes.length <= 32 && bytes(feedbackText(notes)) <= 32768 && bytes(JSON.stringify(notes.map(note => note.card))) <= 1024 * 1024;
}

function validQuote(value: unknown): value is ReplyQuote {
  return !!value && typeof value === "object" && "author" in value && (value.author === "Pi" || value.author === "You") &&
    "text" in value && typeof value.text === "string" && bytes(value.text) <= 32768;
}

/** Restores bounded same-tab drafts. Invalid or blocked storage is disclosed; no request is replayed. */
export function restoreSessionDraft(id: string) {
  let prompt: PromptDraft = { text: "", uncertain: false };
  let feedback: FeedbackDraft = { notes: [], uncertain: false };
  let warning = "";
  try {
    const saved = sessionStorage.getItem(promptKey(id));
    if (saved) {
      if (saved.length > 512 * 1024) throw new Error();
      const value: unknown = JSON.parse(saved);
      if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string" || bytes(value.text) > 128 * 1024 ||
        !("uncertain" in value) || typeof value.uncertain !== "boolean" || ("quote" in value && !validQuote(value.quote))) throw new Error();
      prompt = { text: value.text, quote: "quote" in value ? value.quote as ReplyQuote : undefined, uncertain: value.uncertain };
    }
  } catch { warning = "Your saved draft could not be restored. Keep this page open to protect new unsent work."; }
  try {
    const saved = sessionStorage.getItem(feedbackKey(id));
    if (saved) {
      if (saved.length > 1100000) throw new Error();
      const value: unknown = JSON.parse(saved);
      if (!value || typeof value !== "object" || !("uncertain" in value) || typeof value.uncertain !== "boolean" || !("notes" in value) || !Array.isArray(value.notes) || value.notes.length > 32 ||
        !value.notes.every((note: unknown): note is FeedbackNote => !!note && typeof note === "object" && "id" in note && typeof note.id === "string" && !!note.id && note.id.length <= 128 &&
          "comment" in note && typeof note.comment === "string" && !!note.comment.trim() && "card" in note && validCard(note.card)) ||
        new Set(value.notes.map((note: FeedbackNote) => note.id)).size !== value.notes.length || !feedbackFits(value.notes)) throw new Error();
      feedback = { notes: value.notes, uncertain: value.uncertain };
    }
  } catch { warning = "Saved feedback could not be restored. Keep this page open to protect new unsent work."; }
  return { prompt, feedback, warning };
}

/** Writes one bounded draft independently, so typing never serializes captured feedback code. */
function save(key: string, value: unknown, empty: boolean, limit: number): boolean {
  try {
    if (empty) sessionStorage.removeItem(key);
    else {
      const encoded = JSON.stringify(value);
      if (bytes(encoded) > limit) return false;
      sessionStorage.setItem(key, encoded);
    }
    return true;
  } catch { return false; }
}
export const savePromptDraft = (id: string, value: PromptDraft) => bytes(value.text) <= 128 * 1024 && save(promptKey(id), value, !value.text && !value.quote && !value.uncertain, 512 * 1024);
export const saveFeedbackDraft = (id: string, value: FeedbackDraft) => save(feedbackKey(id), value, !value.notes.length, 1100000);
