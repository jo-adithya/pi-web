import { embeddedImageSize } from "./artifact-image";

const htmlTags = new Set("script canvas button input select option label textarea output a abbr article aside b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i kbd li main mark nav ol p pre s section small span strong style sub summary sup table tbody td th thead time tr u ul wbr".split(" "));
const svgTags = new Set("svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask marker title desc".split(" "));
const attributes = new Set("type value name disabled checked selected min max step placeholder for rows cols maxlength minlength multiple required readonly size class id style title role dir lang open colspan rowspan scope width height viewBox preserveAspectRatio x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity transform text-anchor dominant-baseline font-size font-family font-weight dx dy offset stop-color stop-opacity gradientUnits gradientTransform markerWidth markerHeight refX refY orient marker-start marker-mid marker-end clip-path clipPathUnits maskUnits".split(" "));

/** Keeps bounded interactive HTML/CSS/SVG for the separately sandboxed artifact viewer.
 * Retains at most eight embedded PNG/JPEGs, 32 KiB of image bytes and 2,097,152
 * image pixels in total. Template parsing is inert; the isolated viewer converts
 * accepted data images to local blobs under its resource-restricting CSP.
 */
export function sanitizeArtifact(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = source.slice(0, 65_536);
  const pending: (DocumentFragment | Element)[] = [template.content];
  let images = 0, imageBytes = 0, imagePixels = 0;
  while (pending.length) {
    const root = pending.pop()!;
    for (const child of [...root.children]) {
      const svg = child.namespaceURI === "http://www.w3.org/2000/svg";
      const image = child.namespaceURI === "http://www.w3.org/1999/xhtml" && child.localName === "img";
      const allowed = svg ? svgTags.has(child.localName) : child.namespaceURI === "http://www.w3.org/1999/xhtml" && (htmlTags.has(child.localName) || image);
      if (!allowed) { child.remove(); continue; }
      if (child.localName === "script" && (child.hasAttribute("src") || !["", "text/javascript", "application/javascript"].includes((child.getAttribute("type") ?? "").trim().toLowerCase()))) {
        child.remove(); continue;
      }
      if (image) {
        const size = embeddedImageSize(child.getAttribute("src") ?? "");
        if (!size || images >= 8 || imageBytes + size.bytes > 32_768 || imagePixels + size.pixels > 2_097_152) { child.remove(); continue; }
        images++; imageBytes += size.bytes; imagePixels += size.pixels;
      }
      for (const attribute of [...child.attributes]) {
        if (attribute.namespaceURI || (!attributes.has(attribute.name) && !/^(aria|data)-[a-z0-9_-]+$/.test(attribute.name) && !(image && ["src", "alt"].includes(attribute.name)))) child.removeAttributeNode(attribute);
      }
      if (image) {
        child.setAttribute("referrerpolicy", "no-referrer");
        child.setAttribute("decoding", "async");
      }
      pending.push(child);
    }
  }
  return template.innerHTML;
}
