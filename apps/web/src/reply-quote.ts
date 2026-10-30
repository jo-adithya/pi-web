/** A session-local snapshot of selected chat text and its source author. */
export type ReplyQuote = { author: "Pi" | "You"; text: string };

/** Prefixes each quoted line while preserving the draft exactly for transport. */
export function formatReply(draft: string, quote: ReplyQuote | undefined): string {
  return quote ? `${quote.text.split("\n").map(line => "> " + line).join("\n")}\n\n${draft}` : draft;
}
