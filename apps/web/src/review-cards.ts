import { createSignal } from "solid-js";
import { diffLines, reviewFileReference, reviewScopeReference, type DiffLine, type ReviewEntry, type ReviewFile, type ReviewRequest, type ReviewSnapshot } from "./local-review";

export interface ReviewCardFile { path: string; previousPath: string | null; status: string; lines: DiffLine[] | null }
/** Browser-only snapshot. Only reference is part of the prompt sent to Pi. */
export interface ReviewCard { reference: string; target: ReviewRequest; selection: boolean; files: ReviewCardFile[]; ambiguous?: boolean }
const preview = (file: ReviewEntry): ReviewCardFile => ({ path: file.path, previousPath: file.previousPath, status: file.status, lines: file.patch === null ? null : diffLines(file.patch) });
export function fileReviewCard(file: ReviewFile, target: ReviewRequest, lines?: readonly DiffLine[]): ReviewCard {
  return { reference: reviewFileReference(file, target, lines), target: { ...target }, selection: !!lines, files: [{ ...preview(file), ...(lines ? { lines: lines.map(line => ({ ...line })) } : {}) }] };
}
export function scopeReviewCard(snapshot: ReviewSnapshot, target: ReviewRequest): ReviewCard {
  return { reference: reviewScopeReference(snapshot, target), target: { ...target }, selection: false, files: snapshot.files.map(preview) };
}

/** Guards persisted presentation data; invalid caches fall back to ordinary prompt text. */
function validCard(value: unknown): value is ReviewCard {
  if (!value || typeof value !== "object") return false;
  const c = value as ReviewCard;
  return typeof c.reference === "string" && !!c.reference && typeof c.selection === "boolean" && (c.ambiguous === undefined || typeof c.ambiguous === "boolean") && !!c.target &&
    ["unstaged", "staged", "branch", "commit"].includes(c.target.scope) &&
    (c.target.base === undefined || typeof c.target.base === "string") && (c.target.commit === undefined || typeof c.target.commit === "string") &&
    Array.isArray(c.files) && c.files.length <= 10000 && c.files.every(f => f && typeof f.path === "string" && typeof f.status === "string" &&
      (f.previousPath === null || typeof f.previousPath === "string") && (f.lines === null || Array.isArray(f.lines) && f.lines.every(l => l && typeof l.text === "string" &&
        ["header", "context", "add", "remove"].includes(l.kind) && [l.old, l.next].every(n => n === undefined || Number.isSafeInteger(n) && n >= 0))));
}

/** Retains up to 16 previews / 1 MiB per conversation in this tab. Eviction or unavailable
 * storage leaves readable references in chat; preview content never enters the transport.
 */
export function createReviewCards(sessionId: string) {
  const key = `pi-web:review-cards:v1:${sessionId}`;
  const budget = 1024 * 1024;
  let initial: ReviewCard[] = [];
  try {
    const saved = sessionStorage.getItem(key);
    if (saved && saved.length <= budget) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length <= 16 && parsed.every(validCard)) initial = parsed;
    }
  } catch { /* A disabled or corrupt tab cache must not prevent chatting. */ }
  const [cards, setCards] = createSignal(initial);
  function remember(card: ReviewCard) {
    setCards(previous => {
      const existing = previous.find(item => item.reference === card.reference);
      // References can repeat after edits; do not replace an older message’s preview with different code.
      const captured = existing && (existing.ambiguous || JSON.stringify(existing.files) !== JSON.stringify(card.files))
        ? { ...card, ambiguous: true, files: card.files.map(file => ({ ...file, lines: null })) } : card;
      let next = [...previous.filter(item => item.reference !== card.reference), captured].slice(-16);
      let encoded = JSON.stringify(next);
      while (next.length && new TextEncoder().encode(encoded).length > budget) { next = next.slice(1); encoded = JSON.stringify(next); }
      try { sessionStorage.setItem(key, encoded); } catch { /* Keep in-memory previews when storage is full or disabled. */ }
      return next;
    });
  }
  return { cards, remember };
}

/** Replaces only exact, locally registered references, leaving edited or unknown text intact. */
export function reviewMessageParts(text: string, cards: readonly ReviewCard[]): (string | ReviewCard)[] {
  const parts: (string | ReviewCard)[] = [];
  while (text) {
    let offset = text.length, match: ReviewCard | undefined;
    for (const card of cards) {
      const index = text.indexOf(card.reference);
      if (index >= 0 && index < offset) { offset = index; match = card; }
    }
    if (!match) { parts.push(text); break; }
    if (offset) parts.push(text.slice(0, offset));
    parts.push(match); text = text.slice(offset + match.reference.length);
  }
  return parts;
}

/** Separates known references from the bubble and hides only their generated question scaffolding.
 * Original message text, unmatched references, and manually written instructions remain intact.
 */
export function reviewMessageContent(text: string, cards: readonly ReviewCard[]): { text: string; cards: ReviewCard[] } {
  const parts = reviewMessageParts(text, cards);
  const attached = parts.filter((part): part is ReviewCard => typeof part !== "string");
  if (!attached.length) return { text, cards: [] };
  const selectionPrefix = "Review only. Do not edit files or run mutating commands.\n\nQuestion: ";
  const presetSuffix = "\n\nReview only. Do not edit files or run mutating commands. Distinguish verified findings from uncertainty.\n\n";
  const question = parts.map((part, index) => {
    if (typeof part !== "string") return "";
    if (typeof parts[index + 1] === "object") {
      if (part.startsWith(selectionPrefix)) part = part.slice(selectionPrefix.length);
      if (part.endsWith(presetSuffix)) part = part.slice(0, -presetSuffix.length) + "\n\n";
    }
    return part;
  }).join("").trimEnd();
  return { text: question, cards: attached };
}
