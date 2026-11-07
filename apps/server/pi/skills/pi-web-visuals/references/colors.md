# Theme palette reference

In both light and dark previews, `--background` uses the app’s card color and `--card` uses its background color. This reversal is preview-only; the app’s surfaces are unchanged.

Optional: consult when choosing additional palettes or surface pairs.

Pi Web supplies these CSS variables inside the preview and updates them when its resolved light/dark theme changes. Values are complete CSS colors (currently OKLCH), not channel lists: use `color: var(--foreground)`, not `hsl(var(--foreground))`.

The preview palette is explicitly forwarded by `apps/web/src/components/HtmlArtifact.tsx` from `apps/web/src/tokens.css` and accepted by `apps/server/src/artifact-preview.html`. App-only tokens such as `--popover`, `--popover-foreground`, `--input`, `--ring` and `--chart-1` through `--chart-5` are not forwarded; use the palettes below for visualizations.

The viewer also receives `--radius`, a CSS length (currently `0.625rem`) rather than a color. Use it with `border-radius: var(--radius)`. It updates with the application token and is unchanged by the preview-only surface swap.

### Surface and text pairs

| Purpose | Variables |
| --- | --- |
| Canvas | `var(--background)`, `var(--foreground)` |
| Cards | `var(--card)`, `var(--card-foreground)` |
| Muted content | `var(--muted)`, `var(--muted-foreground)` |
| Borders | `var(--border)` |
| Emphasis | `var(--primary)`, `var(--primary-foreground)` |
| Accents | `var(--accent)`, `var(--accent-foreground)` |
| Secondary surfaces | `var(--secondary)`, `var(--secondary-foreground)` |

### Semantic and categorical colors

Use color purposefully to make diagrams easier to follow, rather than leaving every node neutral. These palettes update with the live light/dark theme:

| Palette | Hue | Use |
| --- | --- | --- |
| `primary` | Violet | Main path, emphasis, shared processing |
| `error` | Red | Defects, failures, actual broken behavior |
| `success` | Green | Expected behavior, verified success, proposed correction (label it as proposed) |
| `warning` | Amber | Risks, cautions, inferred or unverified behavior |
| `info` | Blue | Inputs, context, supporting facts |
| `cyan` | Teal | A distinct component, service, or data stream |
| `orange` | Orange | A distinct stage, dependency, or category |
| `pink` | Pink | Another distinct actor or category |

Every palette has four roles; replace `success` below with any palette name:

| Role | Variable | Example |
| --- | --- | --- |
| Colored text, icon, connector, or solid fill | `var(--success)` | Green label or SVG stroke |
| Soft tinted background | `var(--success-muted)` | Green node surface |
| Colored border | `var(--success-border)` | Green node outline |
| Contrasting text on a **solid** colored fill | `var(--success-foreground)` | Text on `background: var(--success)` |

For a tinted node, combine `color: var(--success); background: var(--success-muted); border: 1px solid var(--success-border)`. For a solid badge, pair `background: var(--success)` with `color: var(--success-foreground)`. Do not use `*-foreground` on a muted surface: it is the inverse text color for the solid fill, not the colored text token.

Reserve red/green/amber for meaning; use blue, teal, violet, orange, or pink to distinguish categories consistently. Choose a few palettes per diagram rather than using every color. Include labels, shapes, or line styles so meaning never depends on color alone. Keep body copy on the normal foreground; avoid low-contrast colored text over unrelated colored surfaces.

Use these variables for surfaces, text, and borders instead of fixed white/black colors or copied palette values. Pair surface and foreground tokens for readable contrast. Use `currentColor` or theme variables for SVG fills and strokes. The root `.dark` class and `color-scheme` also follow Pi Web; use `.dark .your-class` only when a theme-specific adjustment is needed. Do not redefine the supplied variables or detect the theme with JavaScript.

