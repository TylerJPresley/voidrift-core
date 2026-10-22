/**
 * Stage 2a — worker web tools, read-class no-isolation, mode-gated dispatch/merge
 * (core-blueprint.md §3.1, §7.1–§7.5, §8.2, §9.0, §9.5, §9.7).
 *
 * (1) A WORKER that lists `web_fetch`/`web_search` binds them over the SAME
 *     HttpPort path and the SAME single decision point; a worker without them
 *     cannot call them; the gate allows a public target, refuses a private one,
 *     and exempts a configured private SEARCH endpoint for `web_search` only.
 * (2) READ-CLASS dispatch creates NO isolation (no worktree, no staging) in
 *     every mode; WRITE-CLASS dispatch still does.
 * (3) WRITE-CLASS dispatch is DENIED in `research` before any isolation; a
 *     read-class dispatch is a READ (allowed in every mode); `merge_worktree`
 *     and `apply_staging` are DENIED in `research` even under a fan-out grant;
 *     a mode switch between dispatches changes the outcome.
 *
 * Offline/deterministic: a scriptable fake `HttpPort` stands in for loopback web
 * servers (no real network, never a real search provider); `fakeModel()` scripts
 * the worker's tool calls; a FakeVcs/FakeStaging record isolation creation.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage } from "@langchain/core/messages";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { EventBus } from "../entities/event-bus.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";
import { ConfigSchema, type Config, type WebSearchConfig } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";
import type { HttpPort, HttpRequest, HttpResponse, ResolvedAddress } from "../entities/ports/http-port.js";
import type { MergeResult, VcsPort, Worktree } from "../entities/ports/vcs-port.js";
import type { StagingApplyResult, StagingArea, StagingPort } from "../entities/ports/staging-port.js";
import { Subagents, type SubagentsDeps } from "./subagents.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { FilesystemAdapter } from "../adapters/filesystem.js";

/** Map the legacy mode name to a seeded top-level agent whose `unlisted`
 * posture drives the gate (§2.7, §9.7): research→deny, chat→ask, vibe→allow. */
function modeAgent(m: "chat" | "research" | "vibe"): AgentDefinition {
  const unlisted = m === "research" ? "deny" : m === "vibe" ? "allow" : "ask";
  return { name: m, description: "d", kind: "top-level", systemPrompt: "", tools: ["*"], workers: "all", unlisted, ...(unlisted === "allow" ? { confirm: true } : {}) };
}

type Mode = "chat" | "research" | "vibe";

/** A scriptable fake HttpPort: records requests, serves bodies, resolves names
 * to an address a test picks (so a "private target" can be refused by DNS). */
class FakeHttp implements HttpPort {
  requests: HttpRequest[] = [];
  resolveMap: Record<string, ResolvedAddress[]> = {};
  responder: (req: HttpRequest) => { status?: number; body?: string; contentType?: string } = () => ({
    status: 200,
    body: "<html><body><p>hello from loopback</p></body></html>",
    contentType: "text/html",
  });
  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    return this.resolveMap[hostname] ?? [{ address: "93.184.216.34", family: 4 }];
  }
  async fetchOnce(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const r = this.responder(req);
    const body = r.body ?? "";
    return {
      status: r.status ?? 200,
      location: null,
      contentType: r.contentType ?? "text/html",
      readBodyCapped: async (max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
        const enc = new TextEncoder().encode(body);
        return { bytes: enc.slice(0, max), truncated: enc.length > max };
      },
    };
  }
}

/** The DDG HTML fixture the default keyless provider parses (two results). */
const DDG_FIXTURE = `
<div class="result__body">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First Result</a>
  <a class="result__snippet">A snippet about the query.</a>
</div>`;

/** A controllable in-memory VcsPort that records every worktree creation. */
class FakeVcs implements VcsPort {
  repo = true;
  readonly created: string[] = [];
  readonly merged: string[] = [];
  isRepo(): boolean {
    return this.repo;
  }
  async currentBranch(): Promise<string | null> {
    return "main";
  }
  async workingDiff(): Promise<string> {
    return "";
  }
  async createWorktree(id: string): Promise<Worktree> {
    this.created.push(id);
    return { id, path: `/wt/${id}`, branch: `voidrift-run-${id}` };
  }
  async mergeWorktree(wt: Worktree): Promise<MergeResult> {
    this.merged.push(wt.id);
    return { merged: true };
  }
  async abandonWorktree(wt: Worktree): Promise<string> {
    return `voidrift-recovery-${wt.id}`;
  }
  preserveWorktree(wt: Worktree): string {
    return wt.path;
  }
  async bootCleanup(): Promise<string[]> {
    return [];
  }
  async removeWorktreesForSession(): Promise<{ reclaimedBytes: number; remainingRecoveryBranches: string[] }> {
    return { reclaimedBytes: 0, remainingRecoveryBranches: [] };
  }
}

/** An in-memory StagingPort that records every area creation. */
class FakeStaging implements StagingPort {
  readonly created: string[] = [];
  async createArea(run: string): Promise<StagingArea> {
    this.created.push(run);
    return { run, path: `/stage/${run}` };
  }
  async stageWrite(): Promise<void> {}
  async read(): Promise<string | null> {
    return null;
  }
  async manifest() {
    return null;
  }
  async apply(): Promise<StagingApplyResult> {
    return { applied: [], blocked: [] };
  }
  async discard(): Promise<void> {}
  async listRuns(): Promise<string[]> {
    return [];
  }
  async bootCleanup(): Promise<string[]> {
    return [];
  }
  async removeForSession(): Promise<{ reclaimedBytes: number; removedRuns: string[] }> {
    return { reclaimedBytes: 0, removedRuns: [] };
  }
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinToolDefinitions()) reg.register(t.def, t.exec);
  return reg;
}

function cfg(overrides: Partial<Config> = {}): Config {
  // The seeded allow list (§13.8) is what makes the read built-ins and public
  // web tools free — read-class is NOT a permission input (§9). Research still
  // reads/fetches freely BECAUSE of these rules; a non-seeded write still asks.
  return ConfigSchema.parse({ permissions: seededPermissionsRecord(), ...overrides });
}

function reviewerPass() {
  return new FakeListChatModel({ responses: ["PASS: ok"] });
}

/** A worker whose OWN scripted model drives the tool call, resolved via the
 * `resolveModel` seam (invariant 14). */
const workerModels = new Map<string, ReturnType<typeof fakeModel>>();

let root: string;
let bus: EventBus;
let mode: Mode;

function baseDeps(partial: Partial<SubagentsDeps> & { vcs: VcsPort }): SubagentsDeps {
  return {
    chatModel: new FakeListChatModel({ responses: ["done"] }),
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus,
    staging: new FakeStaging(),
    registry: makeRegistry(),
    tempDir: path.join(os.tmpdir(), "no-such"),
    window: 32_000,
    getConfig: () => cfg(),
    workspaceRoot: root,
    sessionId: "orchestrator",
    interactive: true,
    reviewerModel: reviewerPass(),
    resolveModel: (key: string) => workerModels.get(key),
    getActiveAgent: () => modeAgent(mode),
    ...partial,
  };
}

/** Register a worker definition with a scripted model under a unique key. */
function withModel(def: Omit<AgentDefinition, "model">, model: ReturnType<typeof fakeModel>): AgentDefinition {
  const key = `${def.name}-ep-${Math.random().toString(36).slice(2)}`;
  workerModels.set(key, model);
  return { ...def, model: key };
}

beforeEach(async () => {
  root = hermeticTmp("s2a");
  bus = new EventBus();
  mode = "chat";
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  workerModels.clear();
});

describe("Stage 2a (1) — a worker binds the web tools it lists (§8.2)", () => {
  const researcher: Omit<AgentDefinition, "model"> = {
    name: "researcher",
    description: "reads the web",
    systemPrompt: "research",
    tools: ["read_file", "glob_files", "search_contents", "web_fetch", "web_search"],
  };

  it("the researcher's resolved toolset includes web_fetch and web_search", () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(baseDeps({ vcs, http: new FakeHttp() }));
    sa.register({ ...researcher });
    const names = sa.resolvedTools("researcher").map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });

  it("a worker that does NOT list the web tools gets neither", () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(baseDeps({ vcs, http: new FakeHttp() }));
    sa.register({ name: "reader", description: "reads files", systemPrompt: "r", tools: ["read_file", "glob_files"] });
    const names = sa.resolvedTools("reader").map((t) => t.name);
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("web_search");
  });

  it("the researcher calls web_fetch and web_search and gets results (public target)", async () => {
    const http = new FakeHttp();
    http.responder = (req) =>
      req.url.includes("duckduckgo")
        ? { status: 200, body: DDG_FIXTURE, contentType: "text/html" }
        : { status: 200, body: "<html><body><p>fetched body text here</p></body></html>", contentType: "text/html" };
    const vcs = new FakeVcs();
    const results: string[] = [];
    bus.subscribe("TOOL_FINISHED", (e) => {
      const p = e.payload as { name: string; summary: string };
      if (p.name === "web_fetch" || p.name === "web_search") results.push(`${p.name}:${p.summary}`);
    });
    const sa = new Subagents(baseDeps({ vcs, http }));
    const model = fakeModel()
      .respondWithTools([{ name: "web_fetch", args: { url: "https://example.com/doc" } }])
      .respondWithTools([{ name: "web_search", args: { query: "the query" } }])
      .respond(new AIMessage("found it"));
    sa.register(withModel(researcher, model));

    const r = await sa.dispatch([{ agent: "researcher", task: "research X" }]);

    expect(r.workers[0]!.status).toBe("merged");
    // Both web tools ran and returned content (not an Error:).
    expect(results.some((s) => s.startsWith("web_fetch:") && !s.includes("Error"))).toBe(true);
    expect(results.some((s) => s.startsWith("web_search:") && s.includes("First Result"))).toBe(true);
    // The HttpPort was actually reached (DDG + the fetch target).
    expect(http.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("a worker without the web tools cannot call web_fetch (unknown-tool reject)", async () => {
    const http = new FakeHttp();
    const vcs = new FakeVcs();
    const finished: { name: string; status: string }[] = [];
    bus.subscribe("TOOL_FINISHED", (e) => finished.push(e.payload as { name: string; status: string }));
    const sa = new Subagents(baseDeps({ vcs, http }));
    const model = fakeModel()
      .respondWithTools([{ name: "web_fetch", args: { url: "https://example.com/doc" } }])
      .respond(new AIMessage("done"));
    sa.register(withModel({ name: "reader", description: "r", systemPrompt: "r", tools: ["read_file"] }, model));

    await sa.dispatch([{ agent: "reader", task: "try fetch" }]);

    // The call never reached the network — it is rejected as an unknown tool.
    expect(http.requests).toHaveLength(0);
    expect(finished.some((f) => f.name === "web_fetch" && f.status === "error")).toBe(true);
  });
});

describe("Stage 2a (1b) — the worker's web calls pass the ONE decision point (§8.2, §9.3)", () => {
  const researcher: Omit<AgentDefinition, "model"> = {
    name: "researcher",
    description: "reads the web",
    systemPrompt: "research",
    tools: ["web_fetch", "web_search"],
  };

  it("research mode: a public web_fetch is allowed, a private target is refused", async () => {
    const http = new FakeHttp();
    const vcs = new FakeVcs();
    const finished: { name: string; status: string }[] = [];
    const denied: { tool: string }[] = [];
    bus.subscribe("TOOL_FINISHED", (e) => finished.push(e.payload as { name: string; status: string }));
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as { tool: string }));
    const sa = new Subagents(baseDeps({ vcs, http }));
    // A public fetch first, then a private (loopback) target.
    const model = fakeModel()
      .respondWithTools([{ name: "web_fetch", args: { url: "https://example.com/public" } }])
      .respondWithTools([{ name: "web_fetch", args: { url: "http://127.0.0.1/private" } }])
      .respond(new AIMessage("done"));
    sa.register(withModel(researcher, model));
    mode = "research";

    await sa.dispatch([{ agent: "researcher", task: "fetch both" }]);

    // The public target reached the network; the private one never did.
    expect(http.requests.some((r) => r.url.includes("example.com"))).toBe(true);
    expect(http.requests.some((r) => r.url.includes("127.0.0.1"))).toBe(false);
    expect(finished.some((f) => f.name === "web_fetch" && f.status === "success")).toBe(true);
    // The private target is DENIED at the research gate (research never prompts).
    expect(denied.some((d) => d.tool === "web_fetch")).toBe(true);
  });

  it("web_search with a configured PRIVATE endpoint force-asks → denied under research (no exemption)", async () => {
    const http = new FakeHttp();
    http.responder = () => ({ status: 200, body: JSON.stringify({ results: [{ title: "SX", url: "https://sx/a", content: "c" }] }), contentType: "application/json" });
    const vcs = new FakeVcs();
    const denied: { tool: string }[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as { tool: string }));
    // A self-hosted SearXNG on a private host — a force-ask on EVERY call; research
    // never prompts, so it is denied-and-continue (the known interim UX cost).
    const searxng: WebSearchConfig = { provider: "searxng", endpoint: "http://192.168.1.10:8888" };
    const sa = new Subagents(baseDeps({ vcs, http, getConfig: () => cfg({ webSearch: searxng }), resolveWebSearch: () => searxng }));
    const model = fakeModel()
      .respondWithTools([{ name: "web_search", args: { query: "q" } }])
      .respond(new AIMessage("done"));
    sa.register(withModel(researcher, model));
    mode = "research";

    await sa.dispatch([{ agent: "researcher", task: "search" }]);

    // The private endpoint is force-asked and, under read-only research, denied —
    // it is never reached.
    expect(http.requests.some((r) => r.url.startsWith("http://192.168.1.10:8888"))).toBe(false);
    expect(denied.some((d) => d.tool === "web_search")).toBe(true);
  });

  it("web_fetch of the same private host also force-asks → denied (never reached)", async () => {
    const http = new FakeHttp();
    const vcs = new FakeVcs();
    const denied: { tool: string }[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as { tool: string }));
    const searxng: WebSearchConfig = { provider: "searxng", endpoint: "http://192.168.1.10:8888" };
    const sa = new Subagents(baseDeps({ vcs, http, getConfig: () => cfg({ webSearch: searxng }), resolveWebSearch: () => searxng }));
    const model = fakeModel()
      .respondWithTools([{ name: "web_fetch", args: { url: "http://192.168.1.10:8888/x" } }])
      .respond(new AIMessage("done"));
    sa.register(withModel(researcher, model));
    mode = "research";

    await sa.dispatch([{ agent: "researcher", task: "fetch private" }]);

    // web_fetch of the private host is refused.
    expect(http.requests.some((r) => r.url.includes("192.168.1.10"))).toBe(false);
    expect(denied.some((d) => d.tool === "web_fetch")).toBe(true);
  });
});

describe("Stage 2a (2) — read-class dispatch creates no isolation (§3.1, §7.1)", () => {
  const reader: Omit<AgentDefinition, "model"> = {
    name: "reader",
    description: "reads",
    systemPrompt: "r",
    tools: ["read_file", "glob_files", "web_fetch", "web_search"],
  };

  for (const m of ["chat", "research", "vibe"] as Mode[]) {
    it(`a read-class worker in ${m} mode creates NO worktree and NO staging`, async () => {
      const http = new FakeHttp();
      const vcs = new FakeVcs();
      const staging = new FakeStaging();
      mode = m;
      const sa = new Subagents(baseDeps({ vcs, staging, http }));
      const model = fakeModel()
        .respondWithTools([{ name: "glob_files", args: { pattern: "*" } }])
        .respond(new AIMessage("summary of findings"));
      sa.register(withModel(reader, model));

      const r = await sa.dispatch([{ agent: "reader", task: "read" }]);

      expect(vcs.created).toHaveLength(0);
      expect(staging.created).toHaveLength(0);
      expect(r.workers[0]!.worktree).toBeUndefined();
      expect(r.workers[0]!.staging).toBeUndefined();
      // Its result is its summary; a read-class worker is not merged/applied.
      expect(r.workers[0]!.summary).toContain("summary of findings");
      expect(r.workers[0]!.status).toBe("merged");
    });
  }

  it("a write-class worker in chat still gets a worktree and merges", async () => {
    const vcs = new FakeVcs();
    const staging = new FakeStaging();
    mode = "chat";
    const sa = new Subagents(baseDeps({ vcs, staging }));
    const model = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "f.txt", content: "x" } }])
      .respond(new AIMessage("done"));
    sa.register(withModel({ name: "coder", description: "c", systemPrompt: "c", tools: ["read_file", "write_file"] }, model));

    const r = await sa.dispatch([{ agent: "coder", task: "write" }]);

    expect(vcs.created).toHaveLength(1);
    expect(vcs.merged).toHaveLength(1);
    expect(r.workers[0]!.status).toBe("merged");
    expect(r.workers[0]!.worktree).toBe(`/wt/${vcs.created[0]}`);
  });

  it("a write-class worker with NO repo stages (vibe)", async () => {
    const vcs = new FakeVcs();
    vcs.repo = false;
    const staging = new FakeStaging();
    mode = "vibe";
    const sa = new Subagents(baseDeps({ vcs, staging }));
    const model = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "f.txt", content: "x" } }])
      .respond(new AIMessage("done"));
    sa.register(withModel({ name: "coder", description: "c", systemPrompt: "c", tools: ["read_file", "write_file"] }, model));

    const r = await sa.dispatch([{ agent: "coder", task: "write" }]);

    expect(vcs.created).toHaveLength(0); // no repo
    expect(staging.created).toHaveLength(1); // staged instead
    expect(r.workers[0]!.staging).toBeTruthy();
  });
});

describe("Stage 2a (3) — mode-gated dispatch and merge (§9.5, §9.7)", () => {
  const coder = { name: "coder", description: "c", systemPrompt: "c", tools: ["read_file", "write_file"] };
  const reader = { name: "reader", description: "r", systemPrompt: "r", tools: ["read_file", "glob_files"] };

  it("research DENIES a write-class dispatch with the guidance and creates nothing", async () => {
    const vcs = new FakeVcs();
    const staging = new FakeStaging();
    mode = "research";
    const denied: { tool: string; reason: string }[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as { tool: string; reason: string }));
    const sa = new Subagents(baseDeps({ vcs, staging }));
    const model = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "f.txt", content: "x" } }])
      .respond(new AIMessage("done"));
    sa.register(withModel(coder, model));

    const r = await sa.dispatch([{ agent: "coder", task: "write" }]);

    expect(r.workers[0]!.status).toBe("failed");
    expect(r.workers[0]!.summary).toContain("switch to a top-level agent that allows changes");
    expect(denied.some((d) => d.tool === "task" && d.reason.includes("read-only workers"))).toBe(true);
    // Nothing was created — the deny landed BEFORE any isolation.
    expect(vcs.created).toHaveLength(0);
    expect(staging.created).toHaveLength(0);
  });

  it("research ALLOWS a read-class dispatch (a dispatch is a READ)", async () => {
    const http = new FakeHttp();
    const vcs = new FakeVcs();
    mode = "research";
    const sa = new Subagents(baseDeps({ vcs, http }));
    const model = fakeModel()
      .respondWithTools([{ name: "glob_files", args: { pattern: "*" } }])
      .respond(new AIMessage("read ok"));
    sa.register(withModel(reader, model));

    const r = await sa.dispatch([{ agent: "reader", task: "read" }]);

    expect(r.workers[0]!.status).toBe("merged");
    expect(vcs.created).toHaveLength(0);
  });

  it("a mode switch between dispatches changes the write-class outcome", async () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(baseDeps({ vcs }));
    const mkModel = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "f.txt", content: "x" } }])
        .respond(new AIMessage("done"));
    sa.register(withModel({ ...coder, name: "coder-a" }, mkModel()));
    sa.register(withModel({ ...coder, name: "coder-b" }, mkModel()));

    mode = "research";
    const r1 = await sa.dispatch([{ agent: "coder-a", task: "w" }]);
    expect(r1.workers[0]!.status).toBe("failed");

    mode = "chat";
    const r2 = await sa.dispatch([{ agent: "coder-b", task: "w" }]);
    expect(r2.workers[0]!.status).toBe("merged");
    expect(vcs.created).toHaveLength(1);
  });

  it("merge is DENIED in research even with a fan-out grant present (gateWrite consults the live mode)", async () => {
    // Dispatch a write-class worker in CHAT so isolation is created and the
    // fan-out grant is open; flip to RESEARCH before the gate runs the merge.
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    let dispatched = false;
    mode = "chat";
    const sa = new Subagents(
      baseDeps({
        vcs,
        guardian,
        // The gate reads the mode LIVE: once the worker's work is done and the
        // merge is about to be gated, the session has moved to research.
        getActiveAgent: () => modeAgent(dispatched ? "research" : mode),
      }),
    );
    const model = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "f.txt", content: "x" } }])
      .respond(new AIMessage("done"));
    sa.register(withModel(coder, model));

    // Flip to research as soon as the first (dispatch-time) mode read is done.
    const denied: { tool: string }[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as { tool: string }));
    bus.subscribe("WORKER_STATUS_CHANGED", (e) => {
      if ((e.payload as { status: string }).status === "reviewed") dispatched = true;
    });
    // Grant is live for the fan-out, but research must still deny the merge.
    const r = await sa.dispatch([{ agent: "coder", task: "write" }]);

    expect(vcs.merged).toHaveLength(0);
    expect(r.workers[0]!.status).toBe("failed");
    expect(denied.some((d) => d.tool === "merge_worktree")).toBe(true);
  });
});

describe("Stage 2a — researcher_save_notes: read-class, no isolation, research can dispatch (§8.6)", () => {
  const researcher: Omit<AgentDefinition, "model"> = {
    name: "researcher",
    description: "reads and records findings",
    systemPrompt: "research",
    tools: ["read_file", "glob_files", "researcher_save_notes"],
  };

  it("a worker holding researcher_save_notes stays READ-class: NO worktree, NO staging, and writes into the findings dir of the REAL session root", async () => {
    const vcs = new FakeVcs();
    const staging = new FakeStaging();
    const notesFs = new FilesystemAdapter(root); // rooted at the REAL session root
    mode = "research"; // the read-only orchestrator can still dispatch it
    const sa = new Subagents(
      baseDeps({ vcs, staging, notesFileSystem: notesFs, getConfig: () => cfg({ findingsDirectories: [".voidrift/research/"] }) }),
    );
    const model = fakeModel()
      .respondWithTools([{ name: "researcher_save_notes", args: { path: ".voidrift/research/q1.md", content: "# finding\n" } }])
      .respond(new AIMessage("recorded"));
    sa.register(withModel(researcher, model));

    const r = await sa.dispatch([{ agent: "researcher", task: "investigate and record" }]);

    // Read-class: the research agent dispatched it (no write-dispatch deny) and
    // it ran with NO isolation.
    expect(r.workers[0]!.status).toBe("merged");
    expect(vcs.created).toHaveLength(0);
    expect(staging.created).toHaveLength(0);
    expect(r.workers[0]!.worktree).toBeUndefined();
    expect(r.workers[0]!.staging).toBeUndefined();
    // The note landed in the user's tree under the findings dir.
    expect(await fsp.readFile(path.join(root, ".voidrift/research/q1.md"), "utf8")).toContain("# finding");
  });

  it("the researcher's resolved toolset includes researcher_save_notes", () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(baseDeps({ vcs, notesFileSystem: new FilesystemAdapter(root) }));
    sa.register({ ...researcher });
    expect(sa.resolvedTools("researcher").map((t) => t.name)).toContain("researcher_save_notes");
  });
});
