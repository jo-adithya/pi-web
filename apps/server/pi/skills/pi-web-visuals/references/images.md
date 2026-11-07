# Embedded raster images

Consult only when an actual raster image is necessary; prefer compact HTML/CSS or inline SVG otherwise.

Use `<img src="data:image/png;base64,..." alt="Meaningful description">` or the equivalent `image/jpeg` URI inside the preview. Supply actual image bytes; never invent base64 or substitute a file path, attachment ID, Markdown image, or remote URL. This preview feature does not generate images or automatically import model attachments. Use an available, authorized image-generation tool to obtain bytes first; if you only have a URL or an oversized file, use inline SVG/a diagram or ask for a separate image workflow instead. Do not fetch private files or remote images merely to fill a visual.

Model-produced images are untrusted inputs too. Pi Web checks canonical base64, declared PNG/JPEG container headers and dimensions; the browser performs the final raster decoding. Invalid/unsupported images are omitted. SVG data images, GIF/WebP, animated PNG, remote URLs, `srcset`, file URLs, and arbitrary blob URLs are rejected. Inline SVG remains available for diagrams and icons.

Limits per preview: eight images, 32 KiB decoded image bytes total, and 2,097,152 pixels total. Each image is at most 32 KiB, 2048 pixels per edge and 1,048,576 pixels. Base64 adds about one third to the byte size and counts toward the existing 64 KiB reply limit. Prefer small optimized illustrations; full-size generated artwork will usually not fit. Use descriptive alt text and responsive sizing; explicit image colors are preserved, not recolored by the theme. Accepted bytes become local blob images inside the isolated viewer; remote and CSS data-image requests remain blocked.

