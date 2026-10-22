import { describe, it, expect } from "vitest";
import {
  sniffImageMime,
  buildImageContentBlock,
  imagePlaceholder,
  extractImagePaths,
  stripOldImageBlocks,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
} from "./image-attachment.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("sniffImageMime — magic bytes, never the extension", () => {
  it("types png/jpeg/gif/webp by signature", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(sniffImageMime(webp)).toBe("image/webp");
  });

  it("returns null for a non-image or too-short payload", () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // %PDF
  });
});

describe("buildImageContentBlock", () => {
  it("builds a data-URL image_url block", () => {
    const b = buildImageContentBlock("image/png", png);
    expect(b.type).toBe("image_url");
    expect(b.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(b.image_url.url).toContain(Buffer.from(png).toString("base64"));
  });
});

describe("extractImagePaths — from SendRequest.payload.images", () => {
  it("accepts a string or string[] and de-dups, drops empties/non-strings", () => {
    expect(extractImagePaths({ images: "a.png" })).toEqual(["a.png"]);
    expect(extractImagePaths({ images: ["a.png", "a.png", "b.png", "", 5] as unknown[] })).toEqual(["a.png", "b.png"]);
    expect(extractImagePaths(undefined)).toEqual([]);
    expect(extractImagePaths({})).toEqual([]);
  });

  it("accepts the CLI's { type: 'image', path } object shape (cli §3.7)", () => {
    expect(extractImagePaths({ images: { type: "image", path: "c.png" } })).toEqual(["c.png"]);
    expect(
      extractImagePaths({ images: [{ type: "image", path: "c.png" }, { type: "image", path: "d.png" }] }),
    ).toEqual(["c.png", "d.png"]);
  });
});

describe("stripOldImageBlocks — history placeholder", () => {
  it("keeps the current turn's images and replaces older ones with a placeholder", () => {
    const block = buildImageContentBlock("image/png", png);
    const messages = [
      { content: [{ type: "text", text: "old" }, block] },
      { content: [{ type: "text", text: "current" }, block] },
    ];
    const out = stripOldImageBlocks(messages, 1);
    // older message: image replaced with a text placeholder
    expect((out[0]!.content as Array<{ type: string }>)[1]!.type).toBe("text");
    expect(JSON.stringify(out[0]!.content)).toContain("[image: image,");
    // current message: unchanged (reference-equal)
    expect(out[1]).toBe(messages[1]);
  });

  it("is a no-op for a text-only history (reference-equal)", () => {
    const messages = [{ content: "hello" }, { content: "world" }];
    const out = stripOldImageBlocks(messages, 1);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
  });
});

describe("caps and placeholder text", () => {
  it("exposes the fixed caps", () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_IMAGES_PER_MESSAGE).toBe(4);
  });
  it("formats the placeholder", () => {
    expect(imagePlaceholder("shot.png", 1234)).toBe("[image: shot.png, 1234 bytes]");
  });
});
