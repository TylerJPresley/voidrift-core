import { describe, it, expect, beforeEach, vi } from "vitest";
import { Manuals } from "./manuals.js";
import { EventBus } from "../entities/event-bus.js";
import type { DocFile } from "../adapters/docs-dir-reader.js";

describe("Manuals.registerDir (§12.8)", () => {
  let manuals: Manuals;
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it("recursively reads *.md files and registers with source/slug prefix", async () => {
    const docs: DocFile[] = [
      {
        slug: "intro",
        raw: `---
summary: Getting started
read-when: before first use
type: reference
---
# Intro

Content here.`,
      },
      {
        slug: "work",
        raw: `---
summary: Orchestrating work
read-when: when planning
type: explanation
---
# Work

Work content.`,
      },
    ];

    const mockReader = vi.fn().mockResolvedValue(docs);
    manuals = new Manuals({ bus, readDocsDir: mockReader });

    await manuals.registerDir("/shipped/docs", "core");

    const list = manuals.list();
    const ids = list.map((m) => m.id).sort();
    expect(ids).toContain("core/intro");
    expect(ids).toContain("core/work");
  });

  it("rejects source that is not lowercase-hyphen slug", async () => {
    manuals = new Manuals({ bus });

    const result = await manuals.registerDir("/docs", "Bad_Source");
    expect(result).toBeDefined();
    expect(result?.code).toContain("INVALID_INPUT");
  });

  it("skips malformed docs and reports via ERROR_OCCURRED", async () => {
    const docs: DocFile[] = [
      {
        slug: "good",
        raw: `---
summary: Good doc
read-when: anytime
type: reference
---
# Good`,
      },
      {
        slug: "bad",
        raw: "# Bad\nNo frontmatter",
      },
    ];

    const errors: any[] = [];
    bus.subscribe("ERROR_OCCURRED", (envelope) => {
      errors.push(envelope.payload);
    });

    const mockReader = vi.fn().mockResolvedValue(docs);
    manuals = new Manuals({ bus, readDocsDir: mockReader });

    await manuals.registerDir("/docs", "core");

    expect(manuals.list().some((m) => m.id === "core/good")).toBe(true);
    expect(manuals.list().some((m) => m.id === "core/bad")).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("bad");
  });

  it("never throws, always returns CoreError or void", async () => {
    manuals = new Manuals({ bus });
    const mockReader = vi.fn().mockRejectedValue(new Error("read failed"));
    manuals = new Manuals({ bus, readDocsDir: mockReader });

    const result = await manuals.registerDir("/docs", "core");
    expect(result === undefined || result.code).toBeTruthy();
  });

  it("detects duplicate ids already registered and reports ERROR_OCCURRED", async () => {
    const docs: DocFile[] = [
      {
        slug: "intro",
        raw: `---
summary: First intro
read-when: anytime
type: reference
---
# Intro`,
      },
    ];

    const errors: any[] = [];
    bus.subscribe("ERROR_OCCURRED", (envelope) => {
      errors.push(envelope.payload);
    });

    const mockReader = vi.fn().mockResolvedValue(docs);
    manuals = new Manuals({ bus, readDocsDir: mockReader });

    // Register first time
    await manuals.registerDir("/docs", "core");
    expect(manuals.list().some((m) => m.id === "core/intro")).toBe(true);

    // Try to register again — should skip with error
    await manuals.registerDir("/docs", "core");
    expect(errors.some((e) => e.message.includes("already registered"))).toBe(true);
  });

  it("skips duplicate ids within the same batch with ERROR_OCCURRED", async () => {
    const docs: DocFile[] = [
      {
        slug: "guide",
        raw: `---
summary: Guide in root
read-when: anytime
type: reference
---
# Guide`,
      },
      {
        slug: "guide",
        raw: `---
summary: Another guide (different subdir)
read-when: anytime
type: reference
---
# Another Guide`,
      },
    ];

    const errors: any[] = [];
    bus.subscribe("ERROR_OCCURRED", (envelope) => {
      errors.push(envelope.payload);
    });

    const mockReader = vi.fn().mockResolvedValue(docs);
    manuals = new Manuals({ bus, readDocsDir: mockReader });

    await manuals.registerDir("/docs", "core");

    // Only one should be registered
    const guides = manuals.list().filter((m) => m.id === "core/guide");
    expect(guides.length).toBe(1);
    expect(errors.some((e) => e.message.includes("Duplicate manual id"))).toBe(true);
  });

  it("records plugin docs for unload and removes them on unregisterPluginDocs", async () => {
    const docs: DocFile[] = [
      {
        slug: "guide",
        raw: `---
summary: Plugin Guide
read-when: anytime
type: reference
---
# Guide`,
      },
      {
        slug: "faq",
        raw: `---
summary: FAQ
read-when: anytime
type: reference
---
# FAQ`,
      },
    ];

    const mockReader = vi.fn().mockResolvedValue(docs);
    manuals = new Manuals({ bus, readDocsDir: mockReader });

    // Register docs with a plugin source
    await manuals.registerDir("/plugin/docs", "myplugin");

    // Verify the docs are registered
    let list = manuals.list();
    let pluginDocs = list.filter((m) => m.id.startsWith("myplugin/"));
    expect(pluginDocs).toHaveLength(2);
    expect(pluginDocs.map((m) => m.id).sort()).toEqual(["myplugin/faq", "myplugin/guide"]);

    // Now unregister all docs for the plugin
    manuals.unregisterPluginDocs("myplugin");

    // Verify the docs are removed
    list = manuals.list();
    pluginDocs = list.filter((m) => m.id.startsWith("myplugin/"));
    expect(pluginDocs).toHaveLength(0);

    // Re-register with the same source — should work after unload
    await manuals.registerDir("/plugin/docs", "myplugin");

    list = manuals.list();
    pluginDocs = list.filter((m) => m.id.startsWith("myplugin/"));
    expect(pluginDocs).toHaveLength(2);
  });
});
