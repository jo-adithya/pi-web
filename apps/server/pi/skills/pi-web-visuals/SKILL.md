---
name: pi-web-visuals
description: Create custom theme-aware HTML/CSS/SVG visuals in Pi Web chat. Use only when the user explicitly requests a visual artifact, or when built-in summary blocks cannot express the explanation well. Normal replies use Pi Web's composable summaries.
---

# Pi Web visuals

Composable summaries are the default: answer normally and let Pi Web arrange the summary with built-in text, tables, charts, diagrams and annotated paths. For a walkthrough or a side-by-side review, describe each path in order and keep costs, risks and proposal status with the steps or paths they qualify; the formatter can lay them out natively. Use this custom HTML-preview skill only when the user explicitly requests a visual artifact, or when the built-in summary blocks cannot express the explanation well. A complex topic alone is not a reason to create a custom preview. Keep custom visuals focused, use supported facts and label illustrative data.

## Output

Return an HTML fragment in a **top-level fenced block** with exact info string `html preview` and a closing fence. Never nest it in lists or quotes. Ordinary `html` fences show source; streaming replies remain code. Completed, untruncated replies offer Preview, Source and Expand. Keep the entire reply comfortably below **64 KiB**.

Use semantic HTML, reusable CSS in `<style>`, and inline SVG. The frame supplies a system font, 14px body text, 16px padding and theme colors; no full document or server needed. Keep the explanation inside the preview without duplicating it outside. Essential caveats, citations and requested actions may remain outside.

## Five design principles

1. **Explain through arrangement.** Use aligned before/after paths, connected steps, grouped architecture nodes or proportional measurement bars—not prose repackaged as cards.
2. **Establish hierarchy.** One takeaway leads. Use weight, size and whitespace; reserve monospace for code. Keep essential text at least 14px. Shorten or reflow rather than shrink.
3. **Group deliberately.** Use alignment and a small spacing scale (4/8/12/16/24/32px). Prefer whitespace to nested cards, decorative gradients or repeated badges.
4. **Preserve meaning.** Never invent measurements or success claims. Keep severity, verification status and uncertainty visible; proposals are not tested fixes. Put secondary evidence in native `<details>`.
5. **Check readability.** Wrap labels, preserve reading order on phones, avoid fixed widths, and check both themes. Name informative SVGs; hide decorative ones with `aria-hidden="true"`. Never claim browser verification from source inspection.

Use optional [composition examples and critique checklist](references/design-composition.md) or [review patterns](references/review-patterns.md) when needed; adapt rather than copy a template.

## Theme

In both light and dark previews, `--background` uses the app’s card color and `--card` uses its background color. This reversal is preview-only; the app’s surfaces are unchanged.

These CSS color variables are available inside every preview and update with Pi Web’s light/dark theme. Use them with `var(--name)`; they contain complete CSS colors, so do not wrap them in `rgb()` or `hsl()`.

| Purpose | Variables |
| --- | --- |
| Canvas | `--background`, `--foreground` |
| Cards | `--card`, `--card-foreground` |
| Muted surfaces and secondary text | `--muted`, `--muted-foreground` |
| Secondary surfaces | `--secondary`, `--secondary-foreground` |
| Accent surfaces | `--accent`, `--accent-foreground` |
| Neutral outlines | `--border` |
| Colored palettes | `--primary`, `--error`, `--success`, `--warning`, `--info`, `--cyan`, `--orange`, `--pink` |

Each colored palette also provides `-muted` (tinted fill), `-border` (outline), and `-foreground` (text on the solid fill), for example `--info-muted`, `--info-border`, `--info-foreground`.

Only these color tokens are forwarded to previews: app tokens such as `--popover`, `--input`, `--ring` and `--chart-1` through `--chart-5` are not supplied. Never redefine supplied tokens. Keep body copy on normal foreground; SVG uses `currentColor` or theme variables.

Use semantic accents sparingly: `error`, `success`, `warning`, `info`, `primary`. Pair tinted fills with their matching `-muted` and `-border` tokens; `-foreground` belongs on the solid accent, not muted fills. Labels/shapes must carry meaning without color. See the optional [palette](references/colors.md).

## Zoomable diagrams

Prefer inline SVG for flowcharts and architecture diagrams: vector labels stay sharp when zoomed. Give the outer SVG a complete `viewBox` containing every node, arrow and label. Large SVGs (viewBox at least 160 × 80) automatically receive a fitted, bounded viewer with pinch zoom, drag-to-pan, zoom buttons and Fit. Keyboard users can focus the diagram and use +/−, arrow keys and 0/Home to fit. Ctrl/⌘ + scroll zooms; ordinary scrolling moves the page.

Do not crop diagrams with fixed-height, `overflow: hidden` containers or `preserveAspectRatio="slice"`. Keep headings and supporting text outside the SVG, and give the SVG an accessible name. Zoom is a reading aid, not a substitute for short, legible labels. Decorative SVGs marked `aria-hidden="true"` are left alone. If a diagram implements its own interaction, set `data-pan-zoom="off"` on it or an ancestor to opt out. Canvas remains available for custom drawing, but requires its own zoom handling, high-DPI rendering and accessible text alternative.

## Optional corner radius

`--radius` is a CSS length, currently `0.625rem`, available in both themes. Use `border-radius: var(--radius)` when rounded corners support the design. The optional `pw-card` helper retains its own 12px radius.

## Bundled layout helpers

Optional `pw-*` classes work immediately; no imports or compiler needed. They use zero-specificity `:where()` selectors, so your artifact CSS can override them. Plain markup keeps its existing styling. Combine layout with explicit spacing:

| Class | Effect |
| --- | --- |
| `pw-stack` | Flex column |
| `pw-row` | Wrapping flex row, vertically centered items |
| `pw-grid` | Auto-fit columns: `minmax(min(100%, 14rem), 1fr)` |
| `pw-card` | Theme card background/foreground/border, 1px border, 16px padding, 12px radius, `min-width: 0` |
| `pw-title` | Zero margin, `clamp(20px, 3vw, 32px)` size, 1.25 line height |
| `pw-text` | Zero margin, 1.6 line height |
| `pw-muted` | Theme muted foreground |
| `pw-small` | 14px font size |
| `pw-gap-1`, `pw-gap-2`, `pw-gap-3`, `pw-gap-4` | Gap: 4, 8, 16, 24px respectively |
| `pw-pad-1`, `pw-pad-2`, `pw-pad-3`, `pw-pad-4` | Padding: 4, 8, 16, 24px respectively; overrides card padding |

```html preview
<section class="pw-stack pw-gap-3" aria-labelledby="comparison-title">
  <h2 id="comparison-title" class="pw-title">Proposed review flow</h2>
  <div class="pw-grid pw-gap-3">
    <section class="pw-card pw-stack pw-gap-2" aria-labelledby="current-title">
      <h3 id="current-title" class="pw-text">Current</h3>
      <p class="pw-text">One reviewer checks every change.</p>
    </section>
    <section class="pw-card pw-stack pw-gap-2" aria-labelledby="proposed-title">
      <h3 id="proposed-title" class="pw-text">Proposed</h3>
      <p class="pw-text">Route changes to the relevant owner.</p>
    </section>
  </div>
  <p class="pw-text pw-muted pw-small">Illustrative proposal; not a measured improvement.</p>
</section>
```

## Icons

Use purposeful, labeled icons: `<span data-icon="check"> Verified</span>`. Names: `arrow-right`, `arrow-left`, `check`, `x`, `info`, `warning`, `code`, `search`, `settings`, `file`, `folder`, `clock`, `plus`, `minus`.

Only span markers expand, before scripts on initial render. Unknown names preserve content. Icons inherit color and font size; generated SVGs are decorative. Wrapper text/attributes remain. Give icon-only wrappers `role="img"` and `aria-label`. No imports needed.

## Interaction and boundaries

Classic inline scripts run once in document order after initial theme application. Use `addEventListener`; `on*` attributes are removed. Canvas, button, input, select/option, label, textarea, output and `data-*` are supported. Theme updates do not rerun scripts; canvas can redraw on window `pi-web-theme-change`. Off-screen, Source/Preview and full-screen remounts reset state.

For bundled Chart.js 4.6.1, read [chart usage](references/charts.md). For small embedded PNG/JPEGs, read [image budgets](references/images.md); prefer HTML/SVG over base64. No attachment import or remote fetching.

The opaque-origin sandbox blocks same-origin access, remote scripts, modules, eval, connections, embedded frames, form submission, popups and top navigation. External fonts/styles/images and other libraries are unsupported. Markup is sanitized. Self-frame navigation remains possible: this is not an absolute no-network guarantee. There is no CPU quota; avoid unbounded or expensive work. No parent commands or privileged capabilities are exposed. Never request relaxed permissions.
