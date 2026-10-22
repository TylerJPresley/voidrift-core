import { describe, it, expect } from "vitest";
import { parseAgentManifest, AgentManifestError, DEFAULT_AGENT_ORDER } from "./agent-manifest.js";
import { deriveAgentClass } from "./subagents.js";

/** §3.1/§7.1 — agent manifest parsing: JSON + Zod, honest typed failures naming
 * the file and the field/position. The manifest is `agents/<name>/agent.json`. */
describe("parseAgentManifest (§3.1, §7.1)", () => {
  const json = (o: Record<string, unknown>) => JSON.stringify(o);

  it("parses a valid worker manifest into an AgentDefinition", () => {
    const def = parseAgentManifest(
      json({ name: "researcher", description: "Reads", kind: "worker", tools: ["read_file"], prompt: "You research." }),
      "researcher",
    );
    expect(def.name).toBe("researcher");
    expect(def.kind).toBe("worker");
    expect(def.tools).toEqual(["read_file"]);
    expect(def.systemPrompt).toBe("You research.");
  });

  it("parses a valid top-level manifest with workers/unlisted/order/label", () => {
    const def = parseAgentManifest(
      json({ name: "research", description: "orc", kind: "top-level", tools: ["task"], prompt: "p", workers: ["researcher"], unlisted: "deny", order: 20, label: "Research" }),
      "research",
    );
    expect(def.kind).toBe("top-level");
    expect(def.workers).toEqual(["researcher"]);
    expect(def.unlisted).toBe("deny");
    expect(def.order).toBe(20);
    expect(def.label).toBe("Research");
  });

  it("defaults tools to [] and order to DEFAULT_AGENT_ORDER", () => {
    const def = parseAgentManifest(json({ name: "m", description: "d", kind: "top-level", prompt: "p" }), "m");
    expect(def.tools).toEqual([]);
    expect(def.order).toBe(DEFAULT_AGENT_ORDER);
  });

  it("uses prompt.md when no inline prompt, and inline prompt WINS over prompt.md", () => {
    const fromMd = parseAgentManifest(json({ name: "m", description: "d", kind: "worker", tools: [] }), "m", "from the md file");
    expect(fromMd.systemPrompt).toBe("from the md file");
    const inlineWins = parseAgentManifest(json({ name: "m", description: "d", kind: "worker", tools: [], prompt: "inline wins" }), "m", "from the md file");
    expect(inlineWins.systemPrompt).toBe("inline wins");
  });

  it("supports workers: \"all\"", () => {
    const def = parseAgentManifest(json({ name: "vibe", description: "d", kind: "top-level", prompt: "p", workers: "all", unlisted: "allow", confirm: true }), "vibe");
    expect(def.workers).toBe("all");
  });

  // ── reject matrix ─────────────────────────────────────────────────────────
  it("rejects invalid JSON, naming the file and the parse position", () => {
    expect(() => parseAgentManifest("{ not json", "x")).toThrow(/agents\/x\/agent\.json: invalid JSON/);
    try {
      parseAgentManifest("{ not json", "x");
    } catch (e) {
      // JSON.parse messages carry a position ("...position N" or "line/column").
      expect(String((e as Error).message)).toMatch(/position|line|column|Unexpected/);
    }
  });

  it("rejects when name != directory name", () => {
    expect(() => parseAgentManifest(json({ name: "a", description: "d", kind: "worker", prompt: "p" }), "b")).toThrow(
      /name "a" must equal the directory name "b"/,
    );
  });

  it("rejects a non-slug name", () => {
    expect(() => parseAgentManifest(json({ name: "Bad_Name", description: "d", kind: "worker", prompt: "p" }), "Bad_Name")).toThrow(AgentManifestError);
  });

  it("rejects a missing kind", () => {
    expect(() => parseAgentManifest(json({ name: "a", description: "d", prompt: "p" }), "a")).toThrow(/kind/);
  });

  it("rejects an unknown kind", () => {
    expect(() => parseAgentManifest(json({ name: "a", description: "d", kind: "boss", prompt: "p" }), "a")).toThrow(AgentManifestError);
  });

  it("rejects a worker declaring a top-level-only field", () => {
    for (const extra of [{ workers: ["x"] }, { unlisted: "deny" }, { confirm: true }, { order: 5 }, { label: "L" }]) {
      expect(() => parseAgentManifest(json({ name: "a", description: "d", kind: "worker", prompt: "p", ...extra }), "a")).toThrow(
        /top-level-only field/,
      );
    }
  });

  it("rejects unlisted: allow without confirm: true", () => {
    expect(() => parseAgentManifest(json({ name: "a", description: "d", kind: "top-level", prompt: "p", unlisted: "allow" }), "a")).toThrow(
      /confirm must be true when unlisted is "allow"/,
    );
    expect(() => parseAgentManifest(json({ name: "a", description: "d", kind: "top-level", prompt: "p", unlisted: "allow", confirm: false }), "a")).toThrow(
      /confirm must be true/,
    );
  });

  it("rejects a missing prompt (no inline, no prompt.md)", () => {
    expect(() => parseAgentManifest(json({ name: "a", description: "d", kind: "worker", tools: [] }), "a")).toThrow(/a prompt is required/);
  });

  it("rejects an unknown top-level key (strict schema)", () => {
    expect(() => parseAgentManifest(json({ name: "a", description: "d", kind: "worker", prompt: "p", disabled: true }), "a")).toThrow(AgentManifestError);
    expect(() => parseAgentManifest(json({ name: "a", description: "d", kind: "worker", prompt: "p", scope: {} }), "a")).toThrow(AgentManifestError);
  });

  it("does NOT enforce the no-task-tool rule — that is registration's job (§7.1)", () => {
    const def = parseAgentManifest(json({ name: "dispatcher", description: "d", kind: "worker", prompt: "p", tools: ["task"] }), "dispatcher");
    expect(def.tools).toContain("task");
  });

  it("parses an optional model endpoint key (§11)", () => {
    expect(parseAgentManifest(json({ name: "a", description: "d", kind: "worker", prompt: "p", model: "fast" }), "a").model).toBe("fast");
  });
});

/** §3.1/§9 — a worker's class is derived from its tool list, fail closed. */
describe("deriveAgentClass (§3.1, §9)", () => {
  const base = { name: "a", description: "d", systemPrompt: "p", kind: "worker" as const };
  it("read when only read-class tools are held", () => {
    expect(deriveAgentClass({ ...base, tools: ["read_file", "glob_files", "search_contents", "workspace_map", "web_fetch", "web_search", "list_skills", "load_skill"] })).toBe("read");
    expect(deriveAgentClass({ ...base, tools: [] })).toBe("read");
  });
  it("write when ANY write-class tool is held", () => {
    expect(deriveAgentClass({ ...base, tools: ["read_file", "write_file"] })).toBe("write");
    expect(deriveAgentClass({ ...base, tools: ["edit_file"] })).toBe("write");
    expect(deriveAgentClass({ ...base, tools: ["execute_command"] })).toBe("write");
  });
  it("write on an unknown tool — fail closed (§9)", () => {
    expect(deriveAgentClass({ ...base, tools: ["mystery_tool"] })).toBe("write");
  });
  it("a reviewer is always read, regardless of declared tools", () => {
    expect(deriveAgentClass({ ...base, tools: ["write_file"], reviewer: true })).toBe("read");
  });
});
