/**
 * The DoS-safe before-capture reader (core-blueprint.md §10.11 / LOW-3).
 *
 * A huge/sparse target must NOT be fully loaded to be captured: the reader stats
 * first and reads at most `cap + 1` bytes for an over-cap target. An injected fs
 * spy asserts exactly how many bytes were read so a 200 MB sparse file never
 * allocates its full size.
 */
import { describe, it, expect } from "vitest";
import { readTargetBytesBounded, type BoundedReadFs } from "./journal-target-reader.js";
import { JOURNAL_LIMITS } from "../../entities/journal.js";

function spyFs(size: number): { fs: BoundedReadFs; readBytes: () => number; opened: () => boolean } {
  let totalRead = 0;
  let opened = false;
  const fs: BoundedReadFs = {
    existsSync: () => true,
    statSync: () => ({ size, isFile: () => true }),
    openSync: () => {
      opened = true;
      return 3;
    },
    readSync: (_fd, buffer, offset, length, _position) => {
      // Simulate a file full of 0x41; fill exactly `length` each call (one call).
      const n = Math.min(length, buffer.length - offset);
      buffer.fill(0x41, offset, offset + n);
      totalRead += n;
      return n;
    },
    closeSync: () => undefined,
  };
  return { fs, readBytes: () => totalRead, opened: () => opened };
}

describe("readTargetBytesBounded (§10.11 / LOW-3)", () => {
  it("a 200 MB sparse target reads at most cap+1 bytes (never the whole file)", () => {
    const cap = JOURNAL_LIMITS.perTargetContentBytes;
    const huge = 200 * 1024 * 1024; // 200 MB
    const { fs, readBytes } = spyFs(huge);
    const res = readTargetBytesBounded("/huge", fs);
    expect(res).not.toBeNull();
    expect(res!.truncated).toBe(true);
    expect(res!.bytes.length).toBe(cap); // clipped to the cap
    // Only cap+1 was ever read — the 200 MB was never allocated.
    expect(readBytes()).toBeLessThanOrEqual(cap + 1);
  });

  it("a small target is read whole and not truncated", () => {
    const { fs, readBytes } = spyFs(10);
    const res = readTargetBytesBounded("/small", fs);
    expect(res!.truncated).toBe(false);
    expect(res!.bytes.length).toBe(10);
    expect(readBytes()).toBe(10);
  });

  it("a non-existent path returns null and never opens", () => {
    const fs: BoundedReadFs = {
      existsSync: () => false,
      statSync: () => ({ size: 0, isFile: () => true }),
      openSync: () => {
        throw new Error("should not open");
      },
      readSync: () => 0,
      closeSync: () => undefined,
    };
    expect(readTargetBytesBounded("/missing", fs)).toBeNull();
  });

  it("a directory (not a regular file) returns null", () => {
    const fs: BoundedReadFs = {
      existsSync: () => true,
      statSync: () => ({ size: 4096, isFile: () => false }),
      openSync: () => 3,
      readSync: () => 0,
      closeSync: () => undefined,
    };
    expect(readTargetBytesBounded("/dir", fs)).toBeNull();
  });
});
