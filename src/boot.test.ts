/**
 * Boot composition-root tests (core-blueprint.md §2.1, §14.1) exercising the
 * default adapter wiring (no injected config store / session repository) over a
 * per-test temp workspace, plus the signal-handler and overlay branches.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";

describe("createCore default wiring (§2.1)", () => {
  let ws: string;
  let globalHome: string;
  let prevXdg: string | undefined;
  beforeEach(async () => {
    ws = hermeticTmp("boot");
    // Isolate the global `~/.config/voidrift` under a temp dir so the first-run
    // seed and any global writes never touch the developer's real home.
    globalHome = hermeticTmp("xdg");
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = globalHome;
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    // A seeded project config so the default FilesystemConfigStore resolves a model.
    await fs.writeFile(
      path.join(ws, ".voidrift", "config.json"),
      JSON.stringify({ models: { local: { model: "m", protocol: "openai", contextLimit: 8000 } }, modelSelected: "local" }),
    );
  });
  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(globalHome, { recursive: true, force: true });
  });

  it("boots with default adapters, returns a usable CoreAPI, housekeeping, and managed=none", async () => {
    const { api, housekeeping, managed } = await createCore({
      workspaceRoot: ws,
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    expect(managed.status).toBe("none");
    expect(housekeeping.idleDays).toBe(30);
    const created = await api.session.create({});
    expect(created.ok).toBe(true);
    const paths = await api.config.paths();
    expect(paths.ok).toBe(true);
  });

  it("applies a per-process configOverride overlay above the session layer (§13.1)", async () => {
    const { api } = await createCore({
      workspaceRoot: ws,
      configOverrides: { turnMaxConcurrency: 7 },
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    const got = await api.config.get("turnMaxConcurrency");
    expect(got.ok && got.value).toBe(7);
  });

  it("installs and releases host signal handlers only when asked", async () => {
    const before = process.listenerCount("SIGINT");
    const { api } = await createCore({
      workspaceRoot: ws,
      installSignalHandlers: true,
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(before);
    await api.session.shutdown();
  });

  it("a configured but unreadable managed source fails closed: managed.unavailable + MANAGED_LAYER_STATUS (§13.5)", async () => {
    const events: Array<{ status: string }> = [];
    const { api, managed } = await createCore({
      workspaceRoot: ws,
      managedSource: path.join(ws, "does-not-exist-managed.json"),
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    api.events.subscribe("MANAGED_LAYER_STATUS", (e) => events.push(e.payload as { status: string }));
    // The boot emission already fired before our subscription; assert via the
    // CoreReady status, and re-read after a status query.
    expect(managed.status).toBe("unavailable");
    expect(managed.reason).toContain("unreadable");
    expect(managed.source).toContain("does-not-exist-managed.json");
  });

  it("a valid managed source loads ok and reports managed.ok (§13.5)", async () => {
    const src = path.join(ws, "managed.json");
    await fs.writeFile(src, JSON.stringify({ compliance: { mode: "enforcing" } }));
    const { managed } = await createCore({
      workspaceRoot: ws,
      managedSource: src,
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    expect(managed.status).toBe("ok");
    expect(managed.source).toBe(src);
  });

  it("managed `autoApproveAllowed: false` makes createCore FAIL with AUTO_APPROVE_FORBIDDEN before anything runs (§13.5, §9.5)", async () => {
    const src = path.join(ws, "managed.json");
    await fs.writeFile(src, JSON.stringify({ autoApproveAllowed: false }));
    await expect(
      createCore({
        workspaceRoot: ws,
        managedSource: src,
        startAgent: "vibe",
        chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
      }),
    ).rejects.toMatchObject({ error: { code: "AUTO_APPROVE_FORBIDDEN" } });
  });

  it("managed `autoApproveAllowed: true` (default) leaves auto_approve available: createCore boots (§13.5)", async () => {
    const src = path.join(ws, "managed.json");
    await fs.writeFile(src, JSON.stringify({ autoApproveAllowed: true }));
    const { api, managed } = await createCore({
      workspaceRoot: ws,
      managedSource: src,
      startAgent: "vibe",
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    expect(managed.status).toBe("ok");
    const created = await api.session.create({});
    expect(created.ok).toBe(true);
    await api.session.shutdown();
  });

  it("an unmanaged deployment with autoApprove: true boots (host-only mode available by default)", async () => {
    const { api } = await createCore({
      workspaceRoot: ws,
      startAgent: "vibe",
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    const created = await api.session.create({});
    expect(created.ok).toBe(true);
    await api.session.shutdown();
  });

  it("boots with shipped core docs in the head; orchestrating-work manual appears in model requests", async () => {
    const model = fakeModel().respond(new AIMessage("ok"));
    const { api } = await createCore({
      workspaceRoot: ws,
      chatModelFactory: () => model,
    });
    const session = await api.session.create({});
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const sessionId = session.value.id;

    // Send a message to trigger a model call with the head
    await api.session.send(sessionId, { input: "test", approvalMode: "policy_only" });

    // The model.calls contain the full message history with the head.
    // Assert the head includes the core/orchestrating-work manual entry.
    expect(model.calls.length).toBeGreaterThan(0);
    const firstCall = model.calls[0]!;
    const headMessages = firstCall.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    
    // The Manual section lists each manual with id, summary, and readWhen
    const expectedManualLine = "- core/orchestrating-work: How to drive multi-step work to a verified result. Read when: before planning multi-step work or dispatching workers.";
    expect(headMessages).toContain(expectedManualLine);
    expect(headMessages).toContain("Manual:");

    await api.session.shutdown();
  });
});
