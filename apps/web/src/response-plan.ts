import type { AnnotationKind, CanvasNode, ResponseCard, ResponseCheck, ResponseFinding, SimpleResponse } from "./generated/protocol";

export const annotationLabels: Record<AnnotationKind, string> = { context: "Context", cost: "Cost", risk: "Risk" };
export const checkLabels = { failed: "Failed", unverified: "Not verified", skipped: "Skipped", passed: "Passed" };
export function rankedChecks(items: ResponseCheck[]) {
  const rank = { failed: 0, unverified: 1, skipped: 2, passed: 3 };
  return [...items].sort((a, b) => rank[a.status] - rank[b.status]);
}

/** Orders Pi assessments by severity, retaining their order within each severity. */
export function rankedFindings(items: ResponseFinding[]): ResponseFinding[] {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...items].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface CanvasBlock { card: ResponseCard; slot: "warning" | "focus" | "support" | "details" }
/** Flattens a validated composition in DOM/reading order. */
export function compositionIndices(node: CanvasNode): number[] {
  if (node.type === "comparison_panels") return [...node.left.blocks, ...node.right.blocks];
  return node.type === "block" ? [node.index] : node.children.flatMap(compositionIndices);
}

/** Returns the displayed block order. Compositions keep tree order; legacy recipes
 * lead with warnings, then focus, support and optional explanations. */
export function canvasBlocks(response: SimpleResponse): CanvasBlock[] {
  if (!response.canvas) return response.blocks.map(card => ({ card, slot: "support" }));
  if (response.canvas.composition) return compositionIndices(response.canvas.composition).map(index => ({ card: response.blocks[index], slot: "support" }));
  const focus = response.canvas.focus;
  const blocks = response.blocks.map((card, index): CanvasBlock => ({ card,
    slot: card.type === "warning" ? "warning" : index === focus ? "focus" : card.type === "details" ? "details" : "support" }));
  return ["warning", "focus", "support", "details"].flatMap(slot => blocks.filter(block => block.slot === slot));
}
