import { For, Match, Show, Switch, createMemo, createSignal, createUniqueId, onSettled } from "solid-js";
import type { DiagramEdge, DiagramNode, RecordedEvidence, ResponseCard } from "../generated/protocol";
import type { CodeLocation } from "../code-reference";
import { Markdown } from "./Markdown";
import { rankedFindings } from "../response-plan";
import "./response-canvas.css";

type Graphic = Extract<ResponseCard, { type: "diagram" | "chart" | "timeline" | "findings" | "evidence" }>;
export function isGraphic(card: ResponseCard): card is Graphic {
  return ["diagram", "chart", "timeline", "findings", "evidence"].includes(card.type);
}

/** Draws app-owned visuals from validated data. Evidence blocks bind only recorded IDs;
 * other graphics remain explicitly attributed to Pi. */
export function ResponseGraphic(props: { card: Graphic; recorded?: RecordedEvidence; openCode?: (location: CodeLocation) => void }) {
  return <Switch>
    <Match when={props.card.type === "diagram" ? props.card : undefined}>{card => <Diagram card={card()} />}</Match>
    <Match when={props.card.type === "chart" ? props.card : undefined}>{card => <BarChart card={card()} />}</Match>
    <Match when={props.card.type === "timeline" ? props.card.items : undefined}>{items => <>
      <ol class="response-timeline" role="list" aria-label={props.card.title}><For each={items()}>{item => <li data-kind={item.kind}>
        <span class="response-timeline-kind">{item.kind === "hypothesis" ? "Hypothesis" : item.kind === "next" ? "Next check" : "Pi-reported"}</span>
        <strong>{item.label}</strong><Markdown text={item.text} complete allowArtifacts={false} openCode={props.openCode} />
      </li>}</For></ol>
    </>}</Match>
    <Match when={props.card.type === "findings" ? props.card.items : undefined}>{items => <>
      <p class="response-provenance">Pi’s assessment · severity is not independent verification</p>
      <ol class="response-findings" role="list" aria-label={props.card.title}><For each={rankedFindings(items())}>{item => <li data-severity={item.severity}>
        <span class="response-finding-severity">{item.severity}</span><div><strong>{item.title}</strong>
          <Markdown text={item.text} complete allowArtifacts={false} openCode={props.openCode} />
          <Show when={item.location}><code class="response-finding-location">{item.location}</code></Show>
        </div>
      </li>}</For></ol>
    </>}</Match>
    <Match when={props.card.type === "evidence" ? props.card.items : undefined}>{ids => <Evidence ids={ids()} recorded={props.recorded!} openCode={props.openCode} />}</Match>
  </Switch>;
}

/** Keeps comparable values on a shared zero baseline, preserving their decimal spelling. */
function BarChart(props: { card: Extract<Graphic, { type: "chart" }> }) {
  const domain = createMemo(() => {
    let min = 0, max = 0, scale = 0;
    for (const item of props.card.items) {
      const value = Number(item.value);
      min = Math.min(min, value); max = Math.max(max, value); scale = Math.max(scale, Math.abs(value));
    }
    scale ||= 1;
    const span = (max / scale - min / scale) || 1;
    return { scale, span, zero: -(min / scale) / span * 100 };
  });
  const percentage = (value: string) => Number(value) / domain().scale / domain().span * 100;
  return <>
    <p class="response-provenance">Reported by Pi · comparable values, zero baseline</p>
    <dl class="response-bars" aria-label={props.card.title}><For each={props.card.items}>{item => <div class="response-bar-row">
      <dt>{item.label}</dt><dd><strong>{item.value} {props.card.unit}</strong>
        <span class="response-bar-track" aria-hidden="true"><span class="response-bar-zero" style={{ left: `${domain().zero}%` }} /><span class="response-bar-fill" style={{ width: `${Math.abs(percentage(item.value))}%`, "margin-left": `${Math.min(domain().zero, domain().zero + percentage(item.value))}%` }} /></span>
      </dd>
    </div>}</For></dl>
  </>;
}

function Evidence(props: { ids: string[]; recorded: RecordedEvidence; openCode?: (location: CodeLocation) => void }) {
  const files = () => props.recorded.files.filter(file => props.ids.includes(file.id));
  const tools = () => props.recorded.tools.filter(tool => props.ids.includes(tool.id));
  return <div class="response-evidence">
    <span class="response-evidence-label">Recorded by pi-web</span>
    <Show when={files().length}>
      <ul class="response-files" role="list" aria-label="Captured file changes"><For each={files()}>{file => <li data-change={file.change}>
        <span class="response-file-symbol" aria-hidden="true">{file.change === "added" ? "+" : file.change === "deleted" ? "−" : "~"}</span>
        <Show when={props.openCode} fallback={<code>{file.path}</code>}><button type="button" class="response-file-link" aria-label={`Open ${file.path} in Changes`} onClick={() => props.openCode?.({ path: file.path, line: 1, endLine: 1 })}>{file.path}</button></Show>
        <span class="response-file-delta"><Show when={file.added !== null} fallback={<span>Counts unavailable</span>}><span class="response-lines-added">+{file.added}</span><span class="response-lines-removed">−{file.removed}</span></Show></span>
      </li>}</For></ul>
      <p class="response-provenance">Changes observed during this turn. Concurrent edits may be included. Links open current Changes/source views, not a historical snapshot.</p>
    </Show>
    <Show when={tools().length}>
      <ol class="response-tool-trace" role="list" aria-label="Observed tool calls"><For each={tools()}>{tool => <li data-outcome={tool.outcome}>
        <span class="response-tool-dot" aria-hidden="true" /><strong>{tool.label}</strong><span>{tool.outcome === "completed" ? "Call completed" : tool.outcome === "error" ? "Tool error" : "Unconfirmed"}</span>
      </li>}</For></ol>
      <p class="response-provenance">Observed RPC outcomes are not proof that tests passed.</p>
    </Show>
    <Show when={props.recorded.omittedFiles || props.recorded.omittedTools}><p class="response-provenance">The recorded view is limited; some observations were omitted.</p></Show>
  </div>;
}

interface PlacedNode { node: DiagramNode; x: number; y: number; lines: string[] }
/** Wraps every label without dropping words; coordinates are owned by the app. */
function wrapLabel(label: string): string[] {
  const result: string[] = []; let line = "";
  for (const word of label.trim().split(/\s+/)) {
    const chunks = Array.from(word).reduce<string[]>((parts, letter, index) => {
      if (index % 18 === 0) parts.push(""); parts[parts.length - 1] += letter; return parts;
    }, []);
    for (const chunk of chunks) {
      if (line && Array.from(line).length + Array.from(chunk).length + 1 > 18) { result.push(line); line = ""; }
      line += (line ? " " : "") + chunk;
    }
  }
  if (line) result.push(line); return result;
}
/** Groups reachable nodes into readable layers. Every supplied edge is drawn, including
 * return edges and self-loops; layout never creates or removes a relationship. */
function placeNodes(nodes: DiagramNode[], edges: DiagramEdge[], columns: number) {
  const seen = new Set<string>(); const groups: DiagramNode[][] = [];
  let frontier = nodes.filter(node => !edges.some(edge => edge.to === node.id && edge.from !== node.id));
  while (seen.size < nodes.length) {
    if (!frontier.length) frontier = [nodes.find(node => !seen.has(node.id))!];
    const ids = new Set(frontier.map(node => node.id));
    const group = nodes.filter(node => ids.has(node.id) && !seen.has(node.id));
    group.forEach(node => seen.add(node.id)); groups.push(group);
    const next = new Set(edges.filter(edge => ids.has(edge.from) && !seen.has(edge.to)).map(edge => edge.to));
    frontier = nodes.filter(node => next.has(node.id));
  }
  const boxHeight = nodes.reduce((height, node) => Math.max(height, wrapLabel(node.label).length * 18 + 46), 88);
  const placed: PlacedNode[] = [];
  if (columns === 3) {
    const rows = Math.min(2, groups.reduce((rows, group) => Math.max(rows, group.length), 1));
    const height = 48 + rows * boxHeight + (rows - 1) * 58;
    let column = 0;
    for (const group of groups) {
      for (let offset = 0; offset < group.length; offset += rows) {
        const part = group.slice(offset, offset + rows);
        part.forEach((node, index) => placed.push({ node, x: 108 + column * 200,
          y: (height - boxHeight) / 2 + (index - (part.length - 1) / 2) * (boxHeight + 58), lines: wrapLabel(node.label) }));
        column++;
      }
    }
    return { nodes: placed, width: column * 200 + 60, height, boxHeight, horizontal: true };
  }
  const width = columns * 200 + 60; let row = 0;
  for (const group of groups) {
    for (let offset = 0; offset < group.length; offset += columns) {
      const part = group.slice(offset, offset + columns);
      part.forEach((node, index) => placed.push({ node, x: width / 2 + (index - (part.length - 1) / 2) * 200, y: 24 + row * (boxHeight + 58), lines: wrapLabel(node.label) }));
      row++;
    }
  }
  return { nodes: placed, width, height: 24 + row * (boxHeight + 58) - 34, boxHeight, horizontal: false };
}
/** Routes one existing edge as an SVG path, keeping return paths outside the node columns. */
function connection(edge: DiagramEdge, nodes: PlacedNode[], height: number, width: number, horizontal: boolean, frameHeight: number) {
  const from = nodes.find(item => item.node.id === edge.from)!; const to = nodes.find(item => item.node.id === edge.to)!;
  if (from === to) {
    const x = from.x + 78, y = from.y + height / 2;
    return `M${x} ${y - 16} C${x + 48} ${y - 58} ${x + 48} ${y + 58} ${x} ${y + 16}`;
  }
  if (horizontal && to.x !== from.x) {
    if (to.x > from.x) {
      const x1 = from.x + 78, x2 = to.x - 78, y1 = from.y + height / 2, y2 = to.y + height / 2, middle = (x1 + x2) / 2;
      return `M${x1} ${y1} C${middle} ${y1} ${middle} ${y2} ${x2 - 4} ${y2}`;
    }
    const y1 = from.y + height, y2 = to.y + height, bottom = frameHeight - 6;
    return `M${from.x} ${y1} C${from.x} ${bottom} ${to.x} ${bottom} ${to.x} ${y2 + 4}`;
  }
  if (to.y < from.y) {
    const x1 = from.x + 78, y1 = from.y + height / 2, x2 = to.x + 78, y2 = to.y + height / 2;
    return `M${x1} ${y1} C${width - 8} ${y1} ${width - 8} ${y2} ${x2} ${y2}`;
  }
  if (to.y === from.y) {
    const direction = to.x > from.x ? 1 : -1; const x1 = from.x + direction * 78, x2 = to.x - direction * 78, y = from.y + height / 2;
    return `M${x1} ${y} L${x2} ${y}`;
  }
  const x1 = from.x, y1 = from.y + height, x2 = to.x, y2 = to.y, middle = (y1 + y2) / 2;
  return `M${x1} ${y1} C${x1} ${middle} ${x2} ${middle} ${x2} ${y2 - 4}`;
}

function Diagram(props: { card: Extract<Graphic, { type: "diagram" }> }) {
  const [columns, setColumns] = createSignal(2);
  const marker = `diagram-${createUniqueId()}`; let container!: HTMLDivElement;
  onSettled(() => {
    const observer = new ResizeObserver(entries => { const width = entries[0].contentRect.width; setColumns(width >= 560 ? 3 : width < 360 ? 1 : 2); });
    observer.observe(container); return () => observer.disconnect();
  });
  const geometry = () => placeNodes(props.card.nodes, props.card.edges, columns());
  return <>
    <p class="response-provenance">Pi’s explanation · <Show when={props.card.edges.some(edge => edge.relation === "hypothesis")} fallback={<>connections follow the source</>}>Dashed links are hypotheses</Show></p>
    <div class="response-diagram" data-compact={props.card.nodes.length <= 4 ? "true" : "false"} ref={container} tabindex={0} role="region" aria-label={`Diagram: ${props.card.title}`}>
      <svg viewBox={`0 0 ${geometry().width} ${geometry().height}`} role="img" aria-label={props.card.title} aria-describedby={`${marker}-description`}>
        <desc id={`${marker}-description`}>Nodes: {props.card.nodes.map(node => node.label).join("; ")}. Connections: {props.card.edges.map(edge => `${props.card.nodes.find(node => node.id === edge.from)!.label} → ${props.card.nodes.find(node => node.id === edge.to)!.label}: ${edge.label}${edge.relation === "hypothesis" ? " (hypothesis)" : ""}`).join(". ")}</desc>
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10" fill="currentColor" /></marker></defs>
        <For each={props.card.edges}>{edge => <g class="response-diagram-edge" data-relation={edge.relation}>
          <Show when={edge.label}><title>{edge.label}</title></Show>
          <path d={connection(edge, geometry().nodes, geometry().boxHeight, geometry().width, geometry().horizontal, geometry().height)} fill="none" marker-end={`url(#${marker})`} />
        </g>}</For>
        <For each={geometry().nodes}>{item => <g class="response-diagram-node" data-kind={item.node.kind}>
          <rect x={item.x - 78} y={item.y} width="156" height={geometry().boxHeight} rx="12" />
          <g class="response-node-symbol" transform={`translate(${item.x - 12},${item.y + 12})`} aria-hidden="true"><NodeSymbol kind={item.node.kind} /></g>
          <text class="response-node-label" text-anchor="middle"><For each={item.lines}>{(line, index) => <tspan x={item.x} y={item.y + 50 + index() * 18}>{line}</tspan>}</For></text>
        </g>}</For>
      </svg>
    </div>
    <Show when={props.card.edges.length}><div class="response-connections"><strong>Connections</strong><ul role="list" aria-label="Diagram connections"><For each={props.card.edges}>{edge => <li>
      <strong>{props.card.nodes.find(node => node.id === edge.from)!.label} → {props.card.nodes.find(node => node.id === edge.to)!.label}</strong>{edge.label ? `: ${edge.label}` : ""}{edge.relation === "hypothesis" ? " (hypothesis)" : ""}
    </li>}</For></ul></div></Show>
  </>;
}
function NodeSymbol(props: { kind: DiagramNode["kind"] }) {
  return <Switch>
    <Match when={props.kind === "input"}><rect x="1" y="1" width="22" height="15" rx="2" /><path d="M7 21h10M12 16v5M2 5h20" /></Match>
    <Match when={props.kind === "store"}><ellipse cx="12" cy="4" rx="10" ry="3" /><path d="M2 4v14c0 4 20 4 20 0V4M2 11c0 4 20 4 20 0" /></Match>
    <Match when={props.kind === "decision"}><path d="M12 1L23 11L12 22L1 11ZM12 22v2" /></Match>
    <Match when={props.kind === "output"}><path d="M14 3H2v18h12M9 12h14M18 7l5 5-5 5" /></Match>
    <Match when={props.kind === "process"}><rect x="2" y="2" width="20" height="20" rx="5" /><path d="M7 8h10M7 12h10M7 16h6" /></Match>
  </Switch>;
}
