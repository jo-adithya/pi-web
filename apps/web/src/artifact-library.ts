/** Loads the bundled Chart.js source as text only when sanitized markup requests it. */
export async function artifactChartJs(html: string): Promise<string | undefined> {
  const template = document.createElement("template");
  template.innerHTML = html;
  if (!template.content.querySelector('script[data-library="chart.js"]')) return undefined;
  return (await import("artifact-chart.js?raw")).default;
}
