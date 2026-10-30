import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("advertises a credential-free standalone app with usable launcher icons", () => {
  const page = new DOMParser().parseFromString(readFileSync("index.html", "utf8"), "text/html");
  const link = page.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  expect(link).not.toBeNull();
  const manifest = JSON.parse(readFileSync(`public${link!.getAttribute("href")}`, "utf8"));
  expect(manifest).toMatchObject({ id: "/", name: "Pi Web", short_name: "Pi", start_url: "/", scope: "/", display: "standalone" });
  expect(page.title).toBe("Pi Web");
  expect(page.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#ffffff");
  expect(manifest.theme_color).toBeUndefined();
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((item: { sizes: string }) => item.sizes === `${size}x${size}`);
    expect(icon.type).toBe("image/png");
    expect(icon.purpose).toBe("any maskable");
    const png = readFileSync(`public${icon.src}`);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
  const appleIcon = page.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  const png = readFileSync(`public${appleIcon!.getAttribute("href")}`);
  expect(png.readUInt32BE(16)).toBe(180);
  expect(png.readUInt32BE(20)).toBe(180);
});
