/**
 * Image attachments for vision turns (core-blueprint.md §3.3 step 2).
 *
 * A turn may carry image paths (the CLI's clipboard paste writes a PNG under a
 * client-owned cache subtree and references the path, cli §3.7). The engine
 * reads each image through the narrow `FileSystemPort.readBinary` seam (same
 * containment/symlink rules as `readFile`) and builds provider-neutral LangChain
 * image content blocks ONLY when the active model declares `vision: true`.
 *
 * This module is the pure part: magic-byte type sniffing (the extension is never
 * trusted), the caps, and the data-URL content-block shape. The I/O (reading the
 * bytes, the vision gate) lives in the engine.
 */

/** Caps fixed in code, not configuration (§3.3): per-image and per-message. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB per image
export const MAX_IMAGES_PER_MESSAGE = 4; // 4 images per message

/** The image MIME types VoidRift attaches, keyed to a magic-byte signature. */
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Sniff an image MIME type from the leading bytes (§3.3). The file extension is
 * NEVER consulted — a `.png` holding a JPEG is typed as a JPEG, and a non-image
 * payload returns `null` so the caller refuses it. Covers png, jpeg, gif, webp.
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // GIF: "GIF87a" or "GIF89a"
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** A provider-neutral image content block ready to go into message content. */
export interface ImageContentBlock {
  type: "image_url";
  image_url: { url: string };
}

/** Build the `data:<mime>;base64,…` content block @langchain/core 1.x accepts. */
export function buildImageContentBlock(mime: ImageMime, bytes: Uint8Array): ImageContentBlock {
  const base64 = Buffer.from(bytes).toString("base64");
  return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } };
}

/** A text placeholder that replaces an image block summarized out of history
 * (§3.3 / §4): `[image: <name>, <bytes> bytes]`. Never carries image bytes. */
export function imagePlaceholder(name: string, bytes: number): string {
  return `[image: ${name}, ${bytes} bytes]`;
}

/** True when a content part is an image block (either the `image_url` shape or a
 * standard-content `{type:"image",...}` part). */
function isImagePart(part: unknown): boolean {
  if (typeof part !== "object" || part === null) return false;
  const t = (part as { type?: unknown }).type;
  return t === "image_url" || t === "image";
}

/**
 * Replace image content blocks with a text placeholder in every message EXCEPT
 * the one at `keepIndex` (the current turn's message, §3.3 / §4). §4 is silent on
 * images, so the fallback keeps the current turn's images and summarizes older
 * ones to `[image: <name>, <bytes> bytes]`, bounding the context an old image
 * would otherwise occupy forever. A message with no image parts is returned
 * unchanged (reference-equal), so this is a cheap no-op for a text-only history.
 *
 * Operates on the provider-neutral content-array shape: each message is
 * `{ content: Array<part> }`. The caller passes the derived view and the index
 * of the message to preserve (the last one); it never mutates the input.
 */
export function stripOldImageBlocks<M extends { content: unknown }>(
  messages: M[],
  keepIndex: number,
): M[] {
  return messages.map((m, i) => {
    if (i === keepIndex) return m;
    const content = m.content;
    if (!Array.isArray(content)) return m;
    if (!content.some(isImagePart)) return m;
    const next = content.map((part) => {
      if (!isImagePart(part)) return part;
      // Derive a byte count from the data-URL when present; name is "image".
      const url = (part as { image_url?: { url?: string } }).image_url?.url ?? "";
      const comma = url.indexOf(",");
      const b64 = comma >= 0 ? url.slice(comma + 1) : "";
      const bytes = b64 ? Math.floor((b64.length * 3) / 4) : 0;
      return { type: "text", text: imagePlaceholder("image", bytes) };
    });
    return { ...m, content: next };
  });
}

/**
 * Extract image attachment paths from a `SendRequest.payload` (§2.3, cli §3.7).
 * The attacher puts the saved path(s) under `payload.images`. Two shapes are
 * accepted: a string / string[] (SDK), and the CLI's `{ type: "image", path }`
 * object / array (cli §3.7). Returns a de-duplicated, order-preserving list of
 * non-empty path strings; anything else yields an empty list.
 */
export function extractImagePaths(payload: Record<string, unknown> | undefined): string[] {
  if (!payload) return [];
  const raw = (payload as { images?: unknown }).images;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of list) {
    let p: string | undefined;
    if (typeof v === "string") p = v;
    else if (typeof v === "object" && v !== null && typeof (v as { path?: unknown }).path === "string") {
      p = (v as { path: string }).path;
    }
    if (p && p.trim() !== "" && !out.includes(p)) out.push(p);
  }
  return out;
}
