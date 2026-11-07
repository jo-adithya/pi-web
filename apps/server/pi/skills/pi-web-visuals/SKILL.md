---
name: pi-web-visuals
description: Create theme-aware static HTML/CSS/SVG visuals in Pi Web chat. Use when a diagram, chart, architecture overview, timeline, or styled before/after comparison would help explain the answer, or when the user requests a visual artifact.
---

# Pi Web visuals

Create a self-contained visual in the assistant reply when it makes the explanation clearer. Prefer ordinary prose or a table when a visual adds little. Use the user's actual facts and label illustrative data.

## Output contract

Put an HTML fragment in a **top-level fenced block** with the exact info string `html preview`, and close the fence. Do not nest it in a list, quote, or another code block. Ordinary `html` fences show source code instead of a preview.

Completed, untruncated assistant replies show the visual with built-in Preview, Source, and Expand controls. Streaming content remains code until completion. Keep the entire reply comfortably below Pi Web's 64 KiB message limit.

Use inline styles, a `<style>` block, semantic HTML, and inline SVG. Return a fragment rather than a full HTML document. The frame already provides a system font, 16px body padding, and inherited text/background colors. No files, dependencies, or separate server are needed to display a visual.

## Follow the live Pi Web theme

Pi Web supplies these CSS variables inside the preview and updates them when its resolved light/dark theme changes:

| Purpose | Variables |
| --- | --- |
| Canvas | `var(--background)`, `var(--foreground)` |
| Cards | `var(--card)`, `var(--card-foreground)` |
| Muted content | `var(--muted)`, `var(--muted-foreground)` |
| Borders | `var(--border)` |
| Emphasis | `var(--primary)`, `var(--primary-foreground)` |
| Accents | `var(--accent)`, `var(--accent-foreground)` |
| Secondary surfaces | `var(--secondary)`, `var(--secondary-foreground)` |

Use these variables for surfaces, text, and borders instead of fixed white/black colors or copied palette values. Pair surface and foreground tokens for readable contrast. Use `currentColor` or theme variables for SVG fills and strokes. The root `.dark` class and `color-scheme` also follow Pi Web; use `.dark .your-class` only when a theme-specific adjustment is needed. Do not redefine the supplied variables or detect the theme with JavaScript.

## Static, isolated rendering

Generated scripts and event handlers cannot run. Navigation, forms, embedded pages, external resources, and network access are disabled. Avoid JavaScript, Mermaid runtimes, chart libraries, external fonts/images/styles, links that need navigation, and interactive controls. Build diagrams with CSS and inline SVG instead. Do not request relaxed sandbox permissions for a static visual.

## Layout and accessibility

- Make the information hierarchy clear: title, short labels, then useful detail.
- Use responsive grids, wrapping labels, and scalable SVG viewBoxes; avoid fixed page widths and horizontal overflow on phones.
- Keep body text legible. Use meaningful headings and text labels rather than color alone to communicate status.
- Give informative SVGs an accessible name; mark purely decorative SVGs `aria-hidden="true"`.
- Prefer a few focused cards or diagram nodes over dense dashboards and unnecessary decoration.

## Minimal example

```html preview
<style>
.comparison { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 16px; }
.comparison section { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
.comparison h2 { margin: 0 0 8px; }
.comparison p { margin: 0; color: var(--muted-foreground); }
</style>
<div class="comparison">
  <section><h2>Before</h2><p>Repeated work at each step.</p></section>
  <section><h2>After</h2><p>One shared result, reused where needed.</p></section>
</div>
```
