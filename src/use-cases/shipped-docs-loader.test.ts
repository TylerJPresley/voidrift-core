import { describe, it, expect } from "vitest";
import { Manuals } from "./manuals.js";
import { EventBus } from "../entities/event-bus.js";
import fs from "node:fs";

describe("shipped-docs-loader", () => {
  it("loads and registers explanation docs at boot", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    // Register the two shipped explanation docs
    const workDoc = fs.readFileSync(
      new URL("../../docs/explanation/orchestrating-work.md", import.meta.url),
      "utf8"
    );
    const systemDoc = fs.readFileSync(
      new URL("../../docs/explanation/thinking-in-systems.md", import.meta.url),
      "utf8"
    );

    const result1 = manuals.registerBuiltin(workDoc, "core/orchestrating-work");
    const result2 = manuals.registerBuiltin(systemDoc, "core/thinking-in-systems");

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    if (result1.ok) {
      expect(result1.value.id).toBe("core/orchestrating-work");
      expect(result1.value.summary).toBeTruthy();
      expect(result1.value.readWhen).toBeTruthy();
      expect(result1.value.source).toBe("builtin");
    }

    if (result2.ok) {
      expect(result2.value.id).toBe("core/thinking-in-systems");
      expect(result2.value.summary).toBeTruthy();
      expect(result2.value.readWhen).toBeTruthy();
      expect(result2.value.source).toBe("builtin");
    }

    // Verify indexLines includes both
    const indexLines = manuals.indexLines();
    expect(indexLines.some((line) => line.id.includes("core/orchestrating-work"))).toBe(
      true
    );
    expect(indexLines.some((line) => line.id.includes("core/thinking-in-systems"))).toBe(
      true
    );
  });

  it("lists registered docs correctly", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    const workDoc = fs.readFileSync(
      new URL("../../docs/explanation/orchestrating-work.md", import.meta.url),
      "utf8"
    );
    manuals.registerBuiltin(workDoc, "core/orchestrating-work");

    const list = manuals.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((m) => m.id === "core/orchestrating-work")).toBe(true);
  });

  it("retrieves registered doc by id", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    const workDoc = fs.readFileSync(
      new URL("../../docs/explanation/orchestrating-work.md", import.meta.url),
      "utf8"
    );
    manuals.registerBuiltin(workDoc, "core/orchestrating-work");

    const doc = manuals.get("core/orchestrating-work");
    expect(doc).not.toBeNull();
    if (doc) {
      expect(doc.id).toBe("core/orchestrating-work");
      expect(doc.source).toBe("builtin");
    }
  });

  it("registerBuiltin emits nothing (silent registration)", () => {
    const events: any[] = [];
    const bus = new EventBus();
    bus.subscribe("*", (envelope) => {
      events.push({ type: envelope.type, payload: envelope.payload });
    });

    const manuals = new Manuals({ bus });

    const workDoc = fs.readFileSync(
      new URL("../../docs/explanation/orchestrating-work.md", import.meta.url),
      "utf8"
    );
    manuals.registerBuiltin(workDoc, "core/orchestrating-work");

    // Verify no RESOURCE_CHANGED event was emitted
    expect(
      events.some((e) => e.type === "RESOURCE_CHANGED" && e.payload?.type === "manual")
    ).toBe(false);
  });

  it("rejects malformed doc with error", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    // Try to register a doc without required frontmatter
    const badDoc = "# Just a heading\n\nNo frontmatter here.";
    const result = manuals.registerBuiltin(badDoc, "core/bad-doc");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toContain("INVALID_INPUT");
    }
  });
});
