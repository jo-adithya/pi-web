import { loadCapability } from "./browser-auth";

export const IMAGE_BYTES = 512 * 1024;
export interface Attachment { id: string; name: string; size: number; preview: string }

/** Explicit capability + same-origin POST, including reads (never ambient img authentication). */
export async function imageRequest(session: string, id: string | null, body?: Blob, proof = loadCapability()): Promise<Response> {
  if (!proof) throw new Error("Open the current login link before using images.");
  const response = await fetch(`/images/${encodeURIComponent(session)}${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
    headers: { "x-pi-capability": proof }, body, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(response.status === 404 ? "Image unavailable. Reattach the original file if needed." : "Image request failed. Your draft was kept.");
  return response;
}

/** Bounded preparation before upload, not a change to Pi history. Small PNG/JPEG
 * files pass through unchanged; larger images resize once to a 1600px longest edge.
 * Source headers are checked before decode to reject oversized pixel allocations.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (file.size > 8 * 1024 * 1024) throw new Error("Choose a PNG or JPEG under 8 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let width = 0, height = 0, mime = "";
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) {
    width = view.getUint32(16); height = view.getUint32(20); mime = "image/png";
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217 || offset + 2 > bytes.length) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); mime = "image/jpeg"; break;
      }
      offset += length;
    }
  }
  if (!mime || !width || !height || width > 8192 || height > 8192 || width * height > 32_000_000) throw new Error("Use a PNG/JPEG no larger than 32 million pixels or 8192px per edge.");
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    if (bitmap.width <= 1600 && bitmap.height <= 1600 && file.size <= IMAGE_BYTES) return new Blob([bytes], { type: mime });
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image preparation is unavailable.");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const prepared = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.8));
    canvas.width = canvas.height = 0;
    if (!prepared || prepared.size > IMAGE_BYTES) throw new Error("Prepared image exceeds 512 KiB. Choose a smaller image.");
    return prepared;
  } finally { bitmap.close(); }
}
