import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseAgentManifest } from "./entities/agent-manifest.js";
import { deriveAgentClass, TASK_TOOL_NAME, type AgentDefinition } from "./entities/subagents.js";
import { seedAgentsDir, SEED_AGENT_NAMES } from "./test-support/seed-agents.js";

/**
 * §3.1 — the core PACKAGE ships SEED agent templates (data only): two top-level
 * (research, vibe) and five workers (researcher, planner, implementer, reviewer,
 * summarizer). The runtime NEVER reads this folder — it is seeded into the
 * user's folders by `config.init` (A2). These tests prove the TEMPLATES parse
 * against the schema and match the pinned content.
 */
const SEED_DIR = seedAgentsDir();

function load(name: string): AgentDefinition {
  const dir = path.join(SEED_DIR, name);
  const raw = fs.readFileSync(path.join(dir, "agent.json"), "utf8");
  const promptMd = fs.existsSync(path.join(dir, "prompt.md")) ? fs.readFileSync(path.join(dir, "prompt.md"), "utf8") : undefined;
  return parseAgentManifest(raw, name, promptMd);
}

describe("seed agent templates shipped by the core package (§3.1)", () => {
  it("ships EXACTLY the two top-level + five worker templates", () => {
    const names = fs
      .readdirSync(SEED_DIR)
      .filter((f) => fs.statSync(path.join(SEED_DIR, f)).isDirectory())
      .sort();
    expect(names).toEqual([...SEED_AGENT_NAMES]);
  });

  it("every template parses and validates against the manifest schema (§3.1)", () => {
    for (const name of SEED_AGENT_NAMES) {
      const def = load(name);
      expect(def.name).toBe(name);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  it("research is top-level, order 20, unlisted deny, with read-only workers", () => {
    const def = load("research");
    expect(def.kind).toBe("top-level");
    expect(def.order).toBe(20);
    expect(def.unlisted).toBe("deny");
    expect(def.workers).toEqual(["researcher", "planner", "reviewer"]);
    // §8.7 — summarizer is dispatched INTERNALLY by the ingest fan-out, not by a
    // model's `task`: research's explicit workers list does NOT include it.
    expect(def.workers).not.toContain("summarizer");
  });

  it("research is a PURE ORCHESTRATOR — no direct read or web tools, only task + notes + memory/skill (§2.7, §3.1)", () => {
    const def = load("research");
    // It holds `task`, the one research write, `ingest` (§8.7 — bound only to a
    // delegating top-level agent), and memory/skill curation — nothing else.
    expect([...def.tools].sort()).toEqual(
      ["delete_memory", "ingest", "list_memory", "list_skills", "load_skill", "read_manual", "researcher_save_notes", "save_memory", "task"].sort(),
    );
    // It must NOT be able to read or reach the web directly — it delegates for that.
    for (const t of ["read_file", "glob_files", "search_contents", "workspace_map", "web_fetch", "web_search", "query_logs"]) {
      expect(def.tools, `research must NOT hold ${t}`).not.toContain(t);
    }
  });

  it("vibe is top-level, order 30, unlisted allow + confirm, workers all, and holds NO write tools", () => {
    const def = load("vibe");
    expect(def.kind).toBe("top-level");
    expect(def.order).toBe(30);
    expect(def.unlisted).toBe("allow");
    expect(def.confirm).toBe(true);
    expect(def.workers).toBe("all");
    for (const t of ["write_file", "edit_file", "execute_command"]) expect(def.tools).not.toContain(t);
  });

  it("derives each worker's class: researcher/planner/reviewer/summarizer read, implementer write (§3.1, §9)", () => {
    expect(deriveAgentClass(load("researcher"))).toBe("read");
    expect(deriveAgentClass(load("planner"))).toBe("read");
    expect(deriveAgentClass(load("reviewer"))).toBe("read");
    expect(deriveAgentClass(load("summarizer"))).toBe("read");
    expect(deriveAgentClass(load("implementer"))).toBe("write");
  });

  it("summarizer is a read-only worker holding EXACTLY ['read_file'] (§8.7) and never `task`", () => {
    const def = load("summarizer");
    expect(def.kind).toBe("worker");
    expect(def.tools).toEqual(["read_file"]);
    expect(def.tools).not.toContain(TASK_TOOL_NAME);
    expect(deriveAgentClass(def)).toBe("read");
  });

  it("the researcher keeps web_fetch + web_search; the reviewer is read-only", () => {
    expect(load("researcher").tools).toEqual(expect.arrayContaining(["web_fetch", "web_search"]));
    expect(load("reviewer").tools).toEqual(["read_file", "glob_files", "search_contents", "workspace_map"]);
  });

  it("the seeded top-level agents (research, vibe) list the three memory tools; workers do not (§6.2)", () => {
    const MEMORY_TOOLS = ["save_memory", "list_memory", "delete_memory"];
    for (const name of ["research", "vibe"]) {
      const tools = load(name).tools;
      for (const t of MEMORY_TOOLS) expect(tools, `${name} must list ${t}`).toContain(t);
    }
    for (const name of ["researcher", "planner", "implementer", "reviewer", "summarizer"]) {
      const tools = load(name).tools;
      for (const t of MEMORY_TOOLS) expect(tools, `${name} must NOT list ${t}`).not.toContain(t);
    }
  });

  it("NO worker declares the task dispatch tool (§7.1); top-level agents DO", () => {
    for (const name of ["researcher", "planner", "implementer", "reviewer", "summarizer"]) {
      expect(load(name).tools).not.toContain(TASK_TOOL_NAME);
    }
    expect(load("research").tools).toContain(TASK_TOOL_NAME);
    expect(load("vibe").tools).toContain(TASK_TOOL_NAME);
  });

  it("the prompts are DOMAIN-NEUTRAL — no code-specific vocabulary (§3.1)", () => {
    const deny = ["git", "worktree", "repository", "repo", "pull request", "unit test", "unit tests", "codebase", "compile", "commit"];
    for (const name of SEED_AGENT_NAMES) {
      const text = `${load(name).description}\n${load(name).systemPrompt}`.toLowerCase();
      for (const word of deny) {
        const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        expect(re.test(text), `template "${name}" prompt contains banned domain word "${word}"`).toBe(false);
      }
    }
  });
});
