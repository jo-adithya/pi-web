# Reading-first coding workspace

Audience: the developer operating a local Pi process. The transcript—not a landing-page hero—is the primary surface.

- Palette: cloud `#eef2f5`, paper `#ffffff`, ink `#233448`, blue `#245a91`, rule `#d4dde7`, warning `#8b5e10`.
- Type: Avenir Next / Segoe UI for reading and controls, Menlo / Consolas for code and tool details. No external fonts or tracking requests.
- Layout: compact project/status header; left-aligned reading column (76ch) with a quiet tool rail; bottom composer. Mobile stacks tool details below the transcript. Only the transcript scrolls on desktop.
- Distinctive choice: tool activity lives beside the prose rather than repeatedly interrupting it. Process, connection, and agent state remain separately legible. User turns receive a restrained inset, not speech bubbles.
- Accessibility: native buttons, textarea and disclosure elements; explicit labels, visible keyboard focus, plain error guidance, no forced scroll while reviewing older text.

Self-critique before implementation: rejected a dashboard card grid and dark terminal imitation. Both hide the central reading task. Kept a light working-document surface and a single blue action emphasis; no decorative animation, gradients, or arbitrary numbered sections.
