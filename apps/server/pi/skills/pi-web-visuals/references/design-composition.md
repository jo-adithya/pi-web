# Composition examples

Optional design help for HTML previews, not a mandatory template. Start with the reader's question. Use the smallest composition that answers it; keep supplied theme tokens, system fonts and sandbox restrictions. No extra libraries are needed.

## Change: parallel paths, then convergence

Question: what becomes simpler? Align equivalent stages before and after. Let a repeated route contrast with one shared route; use arrows only when they clarify direction. Follow the diagram with a short supported consequence, not a row of speculative benefit badges. Number sections only when there is an order.

This fictional example demonstrates structure, not a tested refactor. Replace its labels with evidence-backed content; retain explicit proposal status when applicable.

```html preview
<style>
.compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:24px}
.compare section{min-width:0;padding:16px;border-inline-start:3px solid var(--border)}
.compare .proposal{border-color:var(--info)}
.compare h3{margin:0 0 12px;font-size:1.15em}
.compare ol{margin:0;padding-inline-start:20px;line-height:1.6}
.compare code{overflow-wrap:anywhere}
</style>
<section>
  <p>Illustrative proposal — not implemented or measured</p>
  <h2>Move the repeated decision into one shared step</h2>
  <div class="compare">
    <section><h3>Before · separate routes</h3><ol><li>Tool call → local check</li><li>Tool list → another check</li><li>Help view → another check</li></ol></section>
    <section class="proposal"><h3>Proposed · shared decision</h3><ol><li>Any entry point</li><li>One <code>decide(context)</code> step</li><li>Render the decision for that view</li></ol></section>
  </div>
  <p><span data-icon="info"> Design intent: keep the decision consistent across views.</span></p>
</section>
```

On narrow frames the paths stack in DOM order. Do not insert a fixed horizontal arrow that becomes misleading after stacking. Use ordinary foreground for explanatory copy; reserve accent color for the structural distinction.

## Process: a readable spine

Question: where does the transition happen? Use an ordered list with a thin vertical rule and short step headings. Put the input, action and resulting state together at each step. Highlight only the important transition; place supporting traces in native details. A sequence number indicates order, not elapsed time. Keep a vertical spine on phones rather than shrinking a wide flowchart.

## Measurement: a shared scale

Question: how much changed? Place labeled horizontal bars on a common zero-based scale, with exact values and units beside them. Show source, sample size and measurement conditions where known. Label estimates and illustrative data prominently. Do not imply speed from fewer lines of code, and do not use equal-sized bars for unequal values. Without comparable measurements, show the structural change instead of a chart.

## Final design pass

- At a glance, does one takeaway dominate without hiding essential caveats?
- Are spacing, heading roles and equivalent positions consistent?
- Would removing a border, badge or icon improve clarity?
- Can long labels wrap without clipping at narrow widths and browser zoom?
- Are text and meaning readable in both themes without relying on color alone?
- Were visual claims actually checked in a browser? If not, do not call them verified.

## Inspiration and scope

Informed by Impeccable's [layout](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/layout.md) and [typography](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/typeset.md) guidance: deliberate reading order, meaningful grouping, restrained role scales and content-led adaptation. These are original, preview-specific instructions and examples, not an installation of Impeccable or its detector. Its CLI, hooks, font loading and live-mode workflows are not part of this skill.
