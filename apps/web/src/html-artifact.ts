const htmlTags = new Set("a abbr article aside b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i kbd li main mark nav ol p pre s section small span strong style sub summary sup table tbody td th thead time tr u ul wbr".split(" "));
const svgTags = new Set("svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask marker title desc".split(" "));
const attributes = new Set("class id style title role dir lang open colspan rowspan scope width height viewBox preserveAspectRatio x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity transform text-anchor dominant-baseline font-size font-family font-weight dx dy offset stop-color stop-opacity gradientUnits gradientTransform markerWidth markerHeight refX refY orient marker-start marker-mid marker-end clip-path clipPathUnits maskUnits".split(" "));

/** Keeps bounded static HTML/CSS/SVG for the separately sandboxed artifact viewer.
 * Template parsing is inert; navigation elements, URL attributes and executable content
 * are discarded. The viewer's CSP independently blocks scripts and resource requests.
 */
export function sanitizeArtifact(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = source.slice(0, 65_536);
  const pending: (DocumentFragment | Element)[] = [template.content];
  while (pending.length) {
    const root = pending.pop()!;
    for (const child of [...root.children]) {
      const svg = child.namespaceURI === "http://www.w3.org/2000/svg";
      const allowed = svg ? svgTags.has(child.localName) : child.namespaceURI === "http://www.w3.org/1999/xhtml" && htmlTags.has(child.localName);
      if (!allowed) { child.remove(); continue; }
      for (const attribute of [...child.attributes]) {
        if (attribute.namespaceURI || (!attributes.has(attribute.name) && !/^aria-[a-z-]+$/.test(attribute.name))) child.removeAttributeNode(attribute);
      }
      pending.push(child);
    }
  }
  return template.innerHTML;
}
