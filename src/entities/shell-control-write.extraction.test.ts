/**
 * S5 re-audit: archive/sync/VCS extraction write-target extraction. Each form
 * that materialises files into a destination must yield that destination so
 * `classifyControlPath` can force-ask/deny a write into a protected dir; the
 * negatives must yield NO protected target (they resolve to non-control paths).
 */
import { describe, it, expect } from "vitest";
import { controlPathWriteTargets } from "./shell-control-write.js";

const POSITIVES: Array<[string, string]> = [
  // tar extraction destinations (short, long, =-attached, combined, bare cluster).
  ["tar -x -C .voidrift/agents", ".voidrift/agents"],
  ["tar -xf a.tgz --directory=.voidrift/agents", ".voidrift/agents"],
  ["tar xzf a.tgz -C .voidrift/agents", ".voidrift/agents"],
  ["sudo tar -xzf a.tgz -C .voidrift/agents", ".voidrift/agents"],
  ["env tar -xf a.tgz -C.voidrift/agents", ".voidrift/agents"],
  ["/usr/bin/tar -x -C .voidrift/agents", ".voidrift/agents"],
  // unzip.
  ["unzip a.zip -d .voidrift/agents", ".voidrift/agents"],
  // rsync/scp/sftp — destination is the last operand.
  ["rsync -a evil/ .voidrift/agents/", ".voidrift/agents/"],
  ["scp a.txt .voidrift/agents/x", ".voidrift/agents/x"],
  ["sftp host:a .voidrift/config.json", ".voidrift/config.json"],
  // git checkout/restore path overwrites.
  ["git checkout -- AGENTS.md", "AGENTS.md"],
  ["git checkout main -- AGENTS.md", "AGENTS.md"],
  ["git restore AGENTS.md", "AGENTS.md"],
  ["git restore --source=HEAD --staged --worktree AGENTS.md", "AGENTS.md"],
  ["git reset --hard -- .voidrift/config.json", ".voidrift/config.json"],
  ["git clean -f .voidrift/agents", ".voidrift/agents"],
  // patch/git apply directory.
  ["patch -d .voidrift/agents", ".voidrift/agents"],
  ["git apply --directory=.voidrift/agents", ".voidrift/agents"],
  // download targets.
  ["curl -o .voidrift/config.json https://x", ".voidrift/config.json"],
  ["curl --output .voidrift/config.json https://x", ".voidrift/config.json"],
  ["wget -O .voidrift/config.json https://x", ".voidrift/config.json"],
  ["wget --output-document=.voidrift/config.json https://x", ".voidrift/config.json"],
  // dd / install -t / cp -t / mv -t / ln -s link.
  ["dd if=/dev/zero of=.voidrift/config.json", ".voidrift/config.json"],
  ["install -t .voidrift/agents x", ".voidrift/agents"],
  ["cp -t .voidrift/agents x", ".voidrift/agents"],
  ["mv -t .voidrift/agents x", ".voidrift/agents"],
  ["ln -sf /tmp/evil .voidrift/config.json", ".voidrift/config.json"],
  ["ln -s /tmp/evil AGENTS.md", "AGENTS.md"],
];

const NEGATIVES: Array<[string, string]> = [
  ["tar -x -C build", ".voidrift/agents"],
  ["unzip a.zip -d out", ".voidrift/agents"],
  ["rsync -a a/ b/", ".voidrift/agents"],
  ["git checkout -- src/x.ts", "AGENTS.md"],
  ["git restore src/x.ts", "AGENTS.md"],
  ["curl -o out.json https://x", ".voidrift/config.json"],
];

describe("controlPathWriteTargets — extraction forms (S5)", () => {
  for (const [cmd, target] of POSITIVES) {
    it(`extracts ${target} from \`${cmd}\``, () => {
      expect(controlPathWriteTargets(cmd)).toContain(target);
    });
  }

  for (const [cmd, mustNotContain] of NEGATIVES) {
    it(`does NOT extract ${mustNotContain} from \`${cmd}\``, () => {
      expect(controlPathWriteTargets(cmd)).not.toContain(mustNotContain);
    });
  }

  it("a no-path git reset --hard / checkout . yields no named path target", () => {
    expect(controlPathWriteTargets("git reset --hard")).toEqual([]);
    // `git checkout .` has no `-- <paths>` form, so no checkout-extraction
    // target (left to the existing always-ask git families).
    expect(controlPathWriteTargets("git checkout .")).toEqual([]);
    // `git stash pop` names no path.
    expect(controlPathWriteTargets("git stash pop")).toEqual([]);
  });
});
