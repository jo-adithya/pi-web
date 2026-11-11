import type { ResponseCard, SimpleResponse } from "./generated/protocol";
import { canvasBlocks, rankedFindings } from "./response-plan";

/** Escapes table delimiters while preserving existing inline Markdown escapes. */
function tableCell(value: string): string {
  return value.replace(/(\\*)\|/g, (_pipe, slashes: string) => `${slashes}${slashes.length % 2 ? "" : "\\"}|`).replace(/\r\n?|\n/g, " ");
}

/** Copies the displayed reading order, including graph relationships, uncertainty,
 * recorded provenance and collapsed details. Original replies use their own copy path. */
export function responseText(response: SimpleResponse): string {
  const prefix = response.canvas && response.canvas.headline.trim() !== response.summary.trim() ? [response.canvas.headline, response.summary] : [response.summary];
  const errors = response.recorded?.tools.filter(tool => tool.outcome === "error").length ?? 0;
  if (errors) prefix.push(`${errors} tool ${errors === 1 ? "error" : "errors"} during work. May include recovered errors; this is not a final test verdict.`);
  return [...prefix, ...canvasBlocks(response).map(({ card }) => blockText(card, response))].join("\n\n");
}
function blockText(card: ResponseCard, response: SimpleResponse): string {
  const reported = ["checks", "facts", "diagram", "chart", "timeline", "findings"].includes(card.type);
  const title = card.type === "warning" ? `Warning: ${card.title}` : card.type === "evidence" ? `${card.title} (recorded by pi-web)` : reported ? `${card.title} (reported by Pi)` : card.title;
  let text: string;
  switch (card.type) {
    case "code": {
      let fence = "```";
      for (const run of card.code.matchAll(/`+/g)) if (run[0].length >= fence.length) fence = "`".repeat(run[0].length + 1);
      const language = card.language?.trim() ?? "";
      const info = /^[A-Za-z0-9_+.-]+$/.test(language) ? language : "";
      text = `${fence}${info}\n${card.code}${card.code.endsWith("\n") ? "" : "\n"}${fence}`;
      break;
    }
    case "table": {
      const row = (cells: string[]) => `| ${cells.map(tableCell).join(" | ")} |`;
      text = [row(card.columns), row(card.columns.map(() => "---")), ...card.rows.map(row)].join("\n"); break;
    }
    case "diagram": {
      const label = (id: string) => card.nodes.find(node => node.id === id)!.label;
      text = [card.nodes.map(node => `${node.label} (${node.kind})`).join("; "), ...card.edges.map(edge => `${label(edge.from)} → ${label(edge.to)}${edge.label ? `: ${edge.label}` : ""}${edge.relation === "hypothesis" ? " (hypothesis)" : ""}`)].join("\n"); break;
    }
    case "chart": text = card.items.map(item => `${item.label}: ${item.value} ${card.unit}`).join("\n"); break;
    case "timeline": text = card.items.map(item => `${item.kind === "hypothesis" ? "Hypothesis" : item.kind === "next" ? "Next check" : "Pi-reported"} — ${item.label}: ${item.text}`).join("\n"); break;
    case "findings": text = rankedFindings(card.items).map(item => `${item.severity.toUpperCase()}: ${item.title}${item.location ? ` (${item.location})` : ""}\n${item.text}`).join("\n"); break;
    case "evidence": {
      const data = response.recorded!;
      text = card.items.map(id => {
        const file = data.files.find(item => item.id === id);
        if (file) return `${file.path} (${file.change})${file.added !== null ? ` +${file.added} −${file.removed}` : " — counts unavailable"}`;
        const tool = data.tools.find(item => item.id === id)!;
        return `${tool.label}: ${tool.outcome === "completed" ? "Call completed" : tool.outcome === "error" ? "Tool error" : "Unconfirmed"}`;
      }).join("\n");
      if (card.items.some(id => id.startsWith("file:"))) text += "\nChanges observed during this turn. Concurrent edits may be included.";
      if (card.items.some(id => id.startsWith("tool:"))) text += "\nObserved RPC outcomes are not proof that tests passed.";
      if (data.omittedFiles || data.omittedTools) text += "\nSome observations were omitted.";
      break;
    }
    case "facts": text = card.items.map(item => `${item.label}: ${item.value}`).join("\n"); break;
    case "comparison": text = `Before: ${card.before}\nAfter: ${card.after}`; break;
    case "flow": text = card.items.join(" → "); break;
    case "checks": text = card.items.map(item => `${item.status[0].toUpperCase()}${item.status.slice(1)}: ${item.text}`).join("\n"); break;
    case "checklist": case "steps": text = card.items.map((item, index) => card.type === "steps" ? `${index + 1}. ${item}` : `• ${item}`).join("\n"); break;
    default: text = card.text;
  }
  return `${title}\n${text}`;
}
