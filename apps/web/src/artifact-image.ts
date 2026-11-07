/** Reads canonical embedded PNG/JPEG container headers within the preview budget.
 * Accepts at most 32 KiB, 2048 pixels per edge and 1,048,576 pixels per image.
 * PNG animation is excluded. Browsers perform the final raster decode; this checks
 * the format, bounded dimensions and container structure before exposing bytes.
 */
export function embeddedImageSize(source: string): { bytes: number; pixels: number } | undefined {
  if (source.length > 23 + 4 * Math.ceil(32_768 / 3)) return;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match || match[2].length % 4 !== 0) return;
  let binary: string;
  try { binary = atob(match[2]); } catch { return; }
  if (binary.length > 32_768 || btoa(binary) !== match[2]) return;
  const data = Uint8Array.from(binary, character => character.charCodeAt(0));
  const dimensions = match[1] === "png" ? pngDimensions(data) : jpegDimensions(data);
  if (!dimensions) return;
  const [width, height] = dimensions;
  const pixels = width * height;
  if (!width || !height || width > 2048 || height > 2048 || pixels > 1_048_576) return;
  return { bytes: data.length, pixels };
}

/** Reads a single-frame PNG's IHDR after checking its bounded chunk layout. */
function pngDimensions(data: Uint8Array): [number, number] | undefined {
  if (data.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => data[index] === value)) return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let dimensions: [number, number] | undefined;
  let hasData = false;
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = view.getUint32(offset);
    const end = offset + length + 12;
    if (end > data.length) return;
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return;
      dimensions = [view.getUint32(16), view.getUint32(20)];
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[data[25]]?.includes(data[24]) || data[26] !== 0 || data[27] !== 0 || data[28] > 1) return;
    } else if (type === "IHDR") return;
    if (["acTL", "fcTL", "fdAT"].includes(type)) return;
    if (type === "IDAT") hasData = true;
    if (type === "IEND") return length === 0 && end === data.length && hasData ? dimensions : undefined;
    offset = end;
  }
}

/** Reads dimensions from an ordinary baseline/extended/progressive JPEG frame. */
function jpegDimensions(data: Uint8Array): [number, number] | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let dimensions: [number, number] | undefined;
  for (let offset = 2; offset + 4 <= data.length;) {
    if (data[offset++] !== 0xff) return;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (offset + 2 > data.length) return;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > data.length) return;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (dimensions || length < 8 || data[offset + 2] !== 8 || length !== 8 + 3 * data[offset + 7]) return;
      dimensions = [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return;
    if (marker === 0xda) return dimensions && offset + length < data.length - 2 ? dimensions : undefined;
    offset += length;
  }
}
