import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Manuals } from "./manuals.js";
import { EventBus } from "../entities/event-bus.js";
import type { Manual } from "../entities/manuals/manual.js";
import { hermeticTmp } from "../test-hermetic.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = hermeticTmp("manuals-use-case");
});

afterEach(() => {
  // hermeticTmp cleanup is automatic
  void tmpDir;
});

function testManual(id: string, source: Manual["source"] = "builtin"): string {
  void id; // Used for semantic clarity
  void source; // Used for semantic clarity
  return `---\nsummary: Test doc\nread-when: anytime\ntype: reference\n---\n\n# ${id}\n\nBody for ${id}`;
}

describe("Manuals use-case (§12.8)", () => {
  it("registers a builtin manual programmatically", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    const raw = testManual("core/intro");
    const result = manuals.registerBuiltin(raw, "core/intro");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("core/intro");
      expect(result.value.summary).toBe("Test doc");
      expect(result.value.type).toBe("reference");
    }
  });

  it("returns an error for duplicate ids", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    const raw = testManual("core/intro");
    const result1 = manuals.registerBuiltin(raw, "core/intro");
    expect(result1.ok).toBe(true);

    const result2 = manuals.registerBuiltin(raw, "core/intro");
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.error.code).toBeDefined();
    }
  });

  it("parses frontmatter: summary, read-when, type", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    const raw = `---
summary: A guide to getting started
read-when: before your first session
type: tutorial
---

# Welcome

Start here.`;
    const result = manuals.registerBuiltin(raw, "core/getting-started");

    expect(result.ok).toBe(true);
    if (result.ok) {
      const dto = result.value;
      expect(dto.summary).toBe("A guide to getting started");
      expect(dto.readWhen).toBe("before your first session");
      expect(dto.type).toBe("tutorial");
    }
  });

  it("lists registered manuals", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    manuals.registerBuiltin(testManual("core/intro"), "core/intro");
    manuals.registerBuiltin(testManual("core/reference"), "core/reference");

    const list = manuals.list();
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.id).sort()).toEqual(["core/intro", "core/reference"]);
  });

  it("does NOT emit RESOURCE_CHANGED on programmatic registration (like builtin skills)", () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe("RESOURCE_CHANGED", (event) => {
      events.push(event);
    });

    const manuals = new Manuals({ bus });
    manuals.registerBuiltin(testManual("core/intro"), "core/intro");

    // No RESOURCE_CHANGED event emitted for programmatic registration
    expect(events).toHaveLength(0);
  });

  it("provides index lines for TOC generation", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    manuals.registerBuiltin(testManual("core/intro"), "core/intro");
    manuals.registerBuiltin(testManual("cli/reference"), "cli/reference");

    const index = manuals.indexLines();
    expect(index).toHaveLength(2);
    expect(index[0]).toEqual({
      id: expect.any(String),
      summary: "Test doc",
      type: "reference",
      readWhen: "anytime",
      contributed: false,
    });
  });

  it("rejects invalid frontmatter in registerBuiltin", () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    const raw = `---
summary: Missing read-when and type
---

Body`;
    const result = manuals.registerBuiltin(raw, "core/incomplete");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("read-when");
    }
  });
});
