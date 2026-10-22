/**
 * The one diff/hash utility (core-blueprint.md §8.2).
 *
 * A single source of hashing and diffing so a cache key (§8.2 `workspace_map`),
 * a document-registry staleness check (§4.5), a worker staging manifest (§7.4),
 * and an approval or tool-result diff (§9.5, §8.2) never diverge. Everything
 * that needs a content hash or a unified diff calls here — nothing forks its own.
 */
import { createHash } from "node:crypto";

/** The content hash of a string, hex-encoded SHA-256 (§8.2). */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** True when two contents hash identically — the shared staleness primitive (§4.5). */
export function contentChanged(before: string, after: string): boolean {
  return contentHash(before) !== contentHash(after);
}

/**
 * A minimal unified diff between two texts, rendered as a fenced ```diff block
 * (§8.2, §9.5). This is a stable contract clients may parse; one implementation
 * backs the `write_file`/`edit_file` result diffs and the approval diffs so they
 * render identically. The algorithm is a line-level longest-common-subsequence,
 * sufficient for the small file edits VoidRift produces.
 */
export function unifiedDiff(before: string, after: string, label = ""): string {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const ops = lcsDiff(a, b);
  const body = ops.map((op) => `${op.sign}${op.line}`).join("\n");
  const header = label ? `# ${label}\n` : "";
  return "```diff\n" + header + body + "\n```";
}

interface DiffOp {
  sign: " " | "+" | "-";
  line: string;
}

/** Line-level LCS diff producing context/add/remove ops in order. */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ sign: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ sign: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ sign: "+", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ sign: "-", line: a[i++]! });
  while (j < m) ops.push({ sign: "+", line: b[j++]! });
  return ops;
}
