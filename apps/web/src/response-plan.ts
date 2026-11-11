import type { ResponseCard, ResponseFinding, SimpleResponse } from "./generated/protocol";

/** Orders Pi assessments by severity, retaining their order within each severity. */
export function rankedFindings(items: ResponseFinding[]): ResponseFinding[] {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...items].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface CanvasBlock { card: ResponseCard; slot: "warning" | "focus" | "support" | "details" }
/** Returns the reading order shared by the canvas and clipboard. Adaptive warnings
 * lead, the selected visual follows, and optional explanations come last. */
export function canvasBlocks(response: SimpleResponse): CanvasBlock[] {
  if (!response.canvas) return response.blocks.map(card => ({ card, slot: "support" }));
  const focus = response.canvas.focus;
  const blocks = response.blocks.map((card, index): CanvasBlock => ({ card,
    slot: card.type === "warning" ? "warning" : index === focus ? "focus" : card.type === "details" ? "details" : "support" }));
  return ["warning", "focus", "support", "details"].flatMap(slot => blocks.filter(block => block.slot === slot));
}
