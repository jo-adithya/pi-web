# Visual review composition patterns

Optional composition help, not repository findings or evidence. Establish the verified trigger, mechanism and consequence before choosing a layout. Replace illustrative labels with supported facts; never invent a contract, tested fix, measurement or affected population to fill space.

## Choose the mechanism, not a card template

| Mechanism | Arrangement | Emphasis |
| --- | --- | --- |
| Wrong decision / missing guard | Aligned expected and actual paths | First divergence; establish the real boundary before calling it wrong |
| Race / stale state | Ordered events beside resulting state | Which response overtakes or overwrites another; no duration bars without measurements |
| Repeated work / decisions | Parallel routes versus convergence | Where work repeats and the proposed shared boundary; no unmeasured speedup claims |
| Lost / overwritten data | Comparable input/output payloads around a marked loss point | What disappears; do not claim permanence without storage/recovery evidence |

Lead with an outcome headline, dominant mechanism diagram and brief consequence. Keep every finding represented, with lower-weight comparisons for secondary issues. Align equivalent steps, emphasize the faulty step, avoid crossed connectors and decorative charts. On phones, preserve causal/chronological order and readable labels rather than shrinking the diagram.

Keep severity, confidence, verification status and essential uncertainty visible. Distinguish observed/tested, source-verified, inferred and proposed states. A proposed design is neither a confirmed defect nor an implemented correction. Use red for demonstrated defects, not disliked code; use category colors for repetition.

## Compact illustrative divergence

This fictional sequence demonstrates alignment and emphasis, not an authorization finding. Adapt the structure only when evidence supports the boundary and consequence.

```html preview
<style>
.paths{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:16px}
.path{border:1px solid;border-radius:10px;padding:16px}
.expected{color:var(--success);background:var(--success-muted);border-color:var(--success-border)}
.actual{color:var(--error);background:var(--error-muted);border-color:var(--error-border)}
</style>
<section>
  <small>Illustrative — not verified</small>
  <h2>A private record crosses the user boundary</h2>
  <div class="paths">
    <section class="path expected"><h3>Expected</h3><ol><li>Request record</li><li>Check ownership</li><li>Refuse access</li></ol></section>
    <section class="path actual"><h3>Actual</h3><ol><li>Request record</li><li><strong>Check missing</strong></li><li>Return private record</li></ol></section>
  </div>
</section>
```

## Secondary evidence

Use native disclosure beneath the finding for real file:line references, source traces, reproduction actions, exact checks with provenance, expected/actual results and remaining gaps:

```html
<details><summary>Evidence and checks</summary><!-- Real evidence here; omit empty drawers. --></details>
```

Keep references selectable HTML text; use SVG for geometry, not tiny listings or long prose. Never ship placeholder evidence.

## Final check

- Can the reader locate the faulty step and consequence from the arrangement? If removing boxes/colors leaves the same prose report, redesign it.
- Are every finding's severity, verification status and essential qualifications visible without opening details?
- Are example facts replaced, numbers supported and proposed paths labeled untested?
- Does narrow layout preserve order and legibility? Do not claim browser verification unless performed.
