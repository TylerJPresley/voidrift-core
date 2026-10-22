/**
 * The mutation-journal before-capture reader (core-blueprint.md §10.11, LOW-3).
 *
 * The journal captures a file target's RAW bytes before a write. Reading the
 * WHOLE file first is a DoS: a 200 MB (or sparse-huge) target would be loaded
 * into memory only to be clipped to the per-target cap. Instead this seam STATS
 * first and, for a target larger than the cap, reads at most `cap + 1` bytes
 * (enough to prove it is over the cap and mark `truncated`) with a positioned
 * `read`, never allocating the whole file.
 *
 * I/O is done directly against `node:fs` (not the text `FileSystemPort`) for the
 * same reason the blob store does: raw Buffer bytes and a positioned partial
 * read are durability/efficiency concerns an adapter owns. The `fs` functions
 * are injected so a test can spy on exactly how many bytes were read and assert
 * a huge sparse file is never fully allocated.
 */
import {
  openSync as realOpenSync,
  readSync as realReadSync,
  closeSync as realCloseSync,
  statSync as realStatSync,
  existsSync as realExistsSync,
  type Stats,
} from "node:fs";
import { JOURNAL_LIMITS } from "../../entities/journal.js";

/** The minimal `node:fs` surface the bounded reader needs (injectable). */
export interface BoundedReadFs {
  existsSync(path: string): boolean;
  statSync(path: string): Pick<Stats, "size" | "isFile">;
  openSync(path: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

const DEFAULT_FS: BoundedReadFs = {
  existsSync: realExistsSync,
  statSync: realStatSync,
  openSync: realOpenSync,
  readSync: realReadSync,
  closeSync: realCloseSync,
};

export interface BoundedReadResult {
  bytes: Buffer;
  /** True when the target was larger than the per-target cap and was clipped to
   * the first `cap` bytes (only `cap + 1` were ever read). */
  truncated: boolean;
}

/**
 * Read a file target's RAW before-state bounded to the per-target cap (§10.11).
 * Returns null when the path does not exist or is not a regular file. STATS
 * first: a target within the cap is read whole; a larger one reads only
 * `cap + 1` bytes (positioned) and returns the first `cap` with `truncated`.
 */
export function readTargetBytesBounded(path: string, fs: BoundedReadFs = DEFAULT_FS): BoundedReadResult | null {
  if (!fs.existsSync(path)) return null;
  const st = fs.statSync(path);
  if (!st.isFile()) return null;
  const cap = JOURNAL_LIMITS.perTargetContentBytes;
  const size = st.size;
  const over = size > cap;
  const toRead = over ? cap + 1 : size;
  if (toRead === 0) return { bytes: Buffer.alloc(0), truncated: false };
  const fd = fs.openSync(path, "r");
  try {
    const buf = Buffer.alloc(toRead);
    let read = 0;
    while (read < toRead) {
      const n = fs.readSync(fd, buf, read, toRead - read, read);
      if (n <= 0) break;
      read += n;
    }
    const bytes = read === toRead ? buf : buf.subarray(0, read);
    if (over) {
      // Clip to the cap; `truncated` marks the drop. Only cap+1 was ever read,
      // so a huge/sparse target is never fully allocated.
      return { bytes: bytes.subarray(0, cap), truncated: true };
    }
    return { bytes, truncated: false };
  } finally {
    fs.closeSync(fd);
  }
}
