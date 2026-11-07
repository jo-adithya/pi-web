# Bundled charts

Use HTML/SVG for simple comparisons; use Chart.js when chart interaction helps. Chart.js 4.6.1 is loaded lazily as text when the preview includes `<script data-library="chart.js"></script>`. It executes only inside the sandbox, before artifact scripts. No imports or CDN URLs are needed.

Read computed theme tokens after initialization; canvas does not automatically recolor when the theme changes. Listen for `pi-web-theme-change` and update the chart. This example uses illustrative data, not measured results:

```html preview
<p>Illustrative data — not measured</p>
<script data-library="chart.js"></script>
<canvas id="chart" role="img" aria-label="Illustrative steps: before 8, after 3"></canvas>
<script>
const ink = () => getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim();
Chart.defaults.color = ink();
const chart = new Chart(document.querySelector('#chart'), {
  type: 'bar', data: { labels: ['Before', 'After'], datasets: [{ label: 'Steps', data: [8, 3] }] }
});
window.addEventListener('pi-web-theme-change', () => {
  Chart.defaults.color = ink();
  chart.update();
});
</script>
```

Apply computed theme colors to dataset fills and borders when needed; CSS variables in canvas color strings are not a substitute for resolved colors. Keep values, units and relevant uncertainty readable outside hover-only tooltips. Use comparable scales and never invent measurements.

Scripts run once per viewer document. Theme changes preserve state, but off-screen, Source/Preview and full-screen remounts reset it. Keep demos self-contained and avoid expensive animation or unbounded loops. This example is an authoring pattern, not a browser-verified visual fixture.
