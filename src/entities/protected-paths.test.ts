import { describe, it, expect } from "vitest";
import { classifyControlPath, classifyReadPath, type ControlPathContext } from "./protected-paths.js";

const CTX: ControlPathContext = {
  workspaceRoot: "/ws",
  globalConfigDir: "/home/u/.config/voidrift",
  home: "/home/u",
};

describe("classifyControlPath — deny class (§8.4, §9.4)", () => {
  it("denies the project config/managed/mcp-pins files (relative and absolute)", () => {
    expect(classifyControlPath(".voidrift/config.json", CTX)).toBe("deny");
    expect(classifyControlPath(".voidrift/managed.json", CTX)).toBe("deny");
    expect(classifyControlPath(".voidrift/mcp-pins.json", CTX)).toBe("deny");
    expect(classifyControlPath("/ws/.voidrift/config.json", CTX)).toBe("deny");
  });

  it("denies the global config dir control files (absolute, ~, $HOME, $XDG_CONFIG_HOME)", () => {
    expect(classifyControlPath("/home/u/.config/voidrift/config.json", CTX)).toBe("deny");
    expect(classifyControlPath("~/.config/voidrift/config.json", CTX)).toBe("deny");
    expect(classifyControlPath("$HOME/.config/voidrift/managed.json", CTX)).toBe("deny");
    expect(classifyControlPath("${HOME}/.config/voidrift/mcp-pins.json", CTX)).toBe("deny");
    expect(classifyControlPath("$XDG_CONFIG_HOME/voidrift/config.json", CTX)).toBe("deny");
  });

  it("denies the per-install rollback integrity key in the global config dir (§10.12)", () => {
    expect(classifyControlPath("/home/u/.config/voidrift/rollback.key", CTX)).toBe("deny");
    expect(classifyControlPath("~/.config/voidrift/rollback.key", CTX)).toBe("deny");
    expect(classifyControlPath("$XDG_CONFIG_HOME/voidrift/rollback.key", CTX)).toBe("deny");
    // A `rollback.key` OUTSIDE the global config dir is not a control file.
    expect(classifyControlPath(".voidrift/rollback.key", CTX)).toBeNull();
  });

  it("denies the plugin store and journal (project and global)", () => {
    expect(classifyControlPath(".voidrift/plugins/x/index.js", CTX)).toBe("deny");
    expect(classifyControlPath(".voidrift/journal/s/0.json", CTX)).toBe("deny");
    expect(classifyControlPath("/home/u/.config/voidrift/plugins/p.js", CTX)).toBe("deny");
    // Independent of the configured global dir (tail match preserves old behaviour).
    expect(classifyControlPath("/other/voidrift/plugins/p.js", CTX)).toBe("deny");
  });

  it("denies the durable registry dir under the global config dir (§12.5)", () => {
    expect(classifyControlPath("/home/u/.config/voidrift/registry/abc123/p.json", CTX)).toBe("deny");
    expect(classifyControlPath("~/.config/voidrift/registry/abc123/p.json", CTX)).toBe("deny");
    expect(classifyControlPath("$XDG_CONFIG_HOME/voidrift/registry/abc/p.json", CTX)).toBe("deny");
    // Independent of the configured global dir (tail-match like the plugin store).
    expect(classifyControlPath("/other/voidrift/registry/abc/p.json", CTX)).toBe("deny");
    // A `.voidrift/registry/**` SHIPPED in the workspace tree is also refused by
    // the file/shell tools (it is never READ by the store, which lives globally).
    expect(classifyControlPath(".voidrift/registry/abc/p.json", CTX)).toBe("deny");
  });

  it("denies the rollback snapshot cache but NOT other cache entries (§10.12)", () => {
    expect(classifyControlPath(".voidrift/cache/snapshots/aabbccdd/timeline.json", CTX)).toBe("deny");
    expect(classifyControlPath(".voidrift/cache/snapshots", CTX)).toBe("deny");
    expect(classifyControlPath("/ws/.voidrift/cache/snapshots/s/blobs/abc", CTX)).toBe("deny");
    expect(classifyControlPath("/home/u/.config/voidrift/cache/snapshots/s/x", CTX)).toBe("deny");
    expect(classifyControlPath("/other/voidrift/cache/snapshots/s/x", CTX)).toBe("deny");
    // Other cache entries (index/symbol caches) are NOT protected.
    expect(classifyControlPath(".voidrift/cache/index/map.json", CTX)).toBeNull();
  });

  it("denies the retrieval index cache but NOT other cache entries (retrieval §4, §8)", () => {
    expect(classifyControlPath(".voidrift/cache/retrieval/vectors.json", CTX)).toBe("deny");
    expect(classifyControlPath(".voidrift/cache/retrieval", CTX)).toBe("deny");
    expect(classifyControlPath("/ws/.voidrift/cache/retrieval/graph.json", CTX)).toBe("deny");
    expect(classifyControlPath("/home/u/.config/voidrift/cache/retrieval/x", CTX)).toBe("deny");
    expect(classifyControlPath("/other/voidrift/cache/retrieval/x", CTX)).toBe("deny");
    // Other cache entries (index/symbol caches) are NOT protected.
    expect(classifyControlPath(".voidrift/cache/index/map.json", CTX)).toBeNull();
  });

  it("resolves .. traversal into a deny path", () => {
    expect(classifyControlPath(".voidrift/a/../config.json", CTX)).toBe("deny");
    expect(classifyControlPath(".voidrift/x/../plugins/evil.js", CTX)).toBe("deny");
  });

  it("folds backslashes and is case-insensitive on the tail", () => {
    expect(classifyControlPath(".voidrift\\config.json", CTX)).toBe("deny");
    expect(classifyControlPath(".VoidRift/Config.json", CTX)).toBe("deny");
  });
});

describe("classifyControlPath — ask class (§8.4, §9.4)", () => {
  it("force-asks agents/skills under the project and global dirs", () => {
    expect(classifyControlPath(".voidrift/agents/chat/prompt.md", CTX)).toBe("ask");
    expect(classifyControlPath(".voidrift/skills/x/SKILL.md", CTX)).toBe("ask");
    expect(classifyControlPath("/home/u/.config/voidrift/agents/chat/agent.json", CTX)).toBe("ask");
    expect(classifyControlPath("~/.config/voidrift/skills/y/SKILL.md", CTX)).toBe("ask");
  });

  it("force-asks git hooks, .git/config, and .github/workflows", () => {
    expect(classifyControlPath(".git/hooks/pre-commit", CTX)).toBe("ask");
    expect(classifyControlPath("/ws/.git/hooks/pre-push", CTX)).toBe("ask");
    expect(classifyControlPath(".git/config", CTX)).toBe("ask");
    expect(classifyControlPath(".github/workflows/ci.yml", CTX)).toBe("ask");
  });

  it("force-asks ~/.ssh/authorized_keys and ~/.ssh/config", () => {
    expect(classifyControlPath("~/.ssh/authorized_keys", CTX)).toBe("ask");
    expect(classifyControlPath("/home/u/.ssh/config", CTX)).toBe("ask");
  });

  it("force-asks AGENTS.md/CLAUDE.md/GEMINI.md/SKILL.md anywhere in the workspace (case-insensitive)", () => {
    expect(classifyControlPath("AGENTS.md", CTX)).toBe("ask");
    expect(classifyControlPath("docs/CLAUDE.md", CTX)).toBe("ask");
    expect(classifyControlPath("/ws/sub/dir/gemini.md", CTX)).toBe("ask");
    expect(classifyControlPath("x/SKILL.md", CTX)).toBe("ask");
  });
});

describe("classifyControlPath — null (not a control path / unresolvable)", () => {
  it("returns null for ordinary files", () => {
    expect(classifyControlPath("src/index.ts", CTX)).toBeNull();
    expect(classifyControlPath(".voidrift/cache/x.json", CTX)).toBeNull();
    expect(classifyControlPath(".voidrift/pluginsss/x.js", CTX)).toBeNull();
    expect(classifyControlPath("README.md", CTX)).toBeNull();
    expect(classifyControlPath("", CTX)).toBeNull();
  });

  it("returns null when a path uses a variable it cannot resolve statically", () => {
    expect(classifyControlPath("$FOO/.voidrift/config.json", CTX)).toBeNull();
    // ${XDG_CONFIG_HOME:-~/.config} is a default-expansion we do not resolve.
    expect(classifyControlPath("${XDG_CONFIG_HOME:-~/.config}/voidrift/config.json", CTX)).toBeNull();
  });

  it("returns null when $XDG_CONFIG_HOME is used but no globalConfigDir in ctx", () => {
    expect(classifyControlPath("$XDG_CONFIG_HOME/voidrift/config.json", { workspaceRoot: "/ws" })).toBeNull();
  });

  it("handles a custom XDG global config dir", () => {
    const ctx: ControlPathContext = {
      workspaceRoot: "/ws",
      globalConfigDir: "/custom/xdg/voidrift",
      home: "/home/u",
    };
    expect(classifyControlPath("/custom/xdg/voidrift/config.json", ctx)).toBe("deny");
    expect(classifyControlPath("$XDG_CONFIG_HOME/voidrift/config.json", ctx)).toBe("deny");
    expect(classifyControlPath("/custom/xdg/voidrift/agents/a/prompt.md", ctx)).toBe("ask");
  });

  it("handles trailing slashes on a directory path", () => {
    expect(classifyControlPath(".voidrift/agents/", CTX)).toBe("ask");
    expect(classifyControlPath(".voidrift/plugins/", CTX)).toBe("deny");
  });
});

describe("classifyReadPath — read-denied control stores and cross-session run cache (§9.4/§10.11/§10.12)", () => {
  it("denies the journal and rollback snapshots regardless of session", () => {
    expect(classifyReadPath(".voidrift/journal/s1/e.ndjson", CTX, "s1")).toBe("deny");
    expect(classifyReadPath("/ws/.voidrift/journal/s1/e.ndjson", CTX, "s1")).toBe("deny");
    expect(classifyReadPath(".voidrift/cache/snapshots/s1/timeline.json", CTX, "s1")).toBe("deny");
  });

  it("denies the per-install rollback.key under the global config dir", () => {
    expect(classifyReadPath("/home/u/.config/voidrift/rollback.key", CTX, "s1")).toBe("deny");
  });

  it("allows the CURRENT session's run-cache blob, denies ANOTHER session's", () => {
    expect(classifyReadPath(".voidrift/cache/run/s1/out-0.txt", CTX, "s1")).toBeNull();
    expect(classifyReadPath(".voidrift/cache/run/s2/out-0.txt", CTX, "s1")).toBe("deny");
    // The run root itself is not a readable blob.
    expect(classifyReadPath(".voidrift/cache/run", CTX, "s1")).toBe("deny");
    // No current session → deny every run-cache read (fail closed).
    expect(classifyReadPath(".voidrift/cache/run/s1/out-0.txt", CTX, undefined)).toBe("deny");
  });

  it("allows ordinary files and the writable cache subtrees", () => {
    expect(classifyReadPath("src/a.ts", CTX, "s1")).toBeNull();
    expect(classifyReadPath(".voidrift/cache/index/sym.json", CTX, "s1")).toBeNull();
    expect(classifyReadPath(".voidrift/config.json", CTX, "s1")).toBeNull(); // read allowed; WRITE is denied
  });
});
