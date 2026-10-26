import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { Manuals } from "./manuals.js";
import { EventBus } from "../entities/event-bus.js";
import { hermeticTmp } from "../test-hermetic.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";

describe("Manuals limits enforcement (§12.8 + §13.11)", () => {
  function fakeLimits(overrides: Record<string, number> = {}): LimitsPort {
    const defaults: Record<string, number> = {
      "docs.maxFiles": 500,
      "docs.maxFileBytes": 262144,
    };
    return {
      get: (key: string) => overrides[key] ?? defaults[key],
      hit: () => undefined,
    } as unknown as LimitsPort;
  }

  it("skips files exceeding docs.maxFileBytes and reports ERROR_OCCURRED", async () => {
    const tmpDir = hermeticTmp("manuals-size-limit");
    const docsDir = path.join(tmpDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    // Create a file within the limit
    await fs.writeFile(
      path.join(docsDir, "small.md"),
      `---
summary: Small doc
read-when: anytime
type: reference
---
# Small content`
    );

    // Create a file exceeding the limit (262144 bytes = 256 KiB)
    const largeContent = `---
summary: Large doc
read-when: anytime
type: reference
---
# Large
${"\n".repeat(100000)}
`.repeat(10); // Make it larger than the default limit

    await fs.writeFile(path.join(docsDir, "large.md"), largeContent);

    const bus = new EventBus();
    const errors: any[] = [];
    bus.subscribe("ERROR_OCCURRED", (envelope) => {
      errors.push(envelope.payload);
    });

    const limits = fakeLimits({ "docs.maxFileBytes": 500 }); // Small limit for testing
    const manuals = new Manuals({ bus, limits });

    await manuals.registerDir(docsDir, "core");

    // small.md should be registered
    expect(manuals.list().some((m) => m.id === "core/small")).toBe(true);

    // large.md should NOT be registered
    expect(manuals.list().some((m) => m.id === "core/large")).toBe(false);

    // ERROR_OCCURRED should have been emitted
    expect(errors.some((e) => e.message.includes("Skipped docs"))).toBe(true);
    expect(errors.some((e) => e.message.includes("size limit"))).toBe(true);
  });

  it("stops reading after docs.maxFiles and reports ERROR_OCCURRED", async () => {
    const tmpDir = hermeticTmp("manuals-count-limit");
    const docsDir = path.join(tmpDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    // Create many doc files
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(
        path.join(docsDir, `doc${i}.md`),
        `---
summary: Doc ${i}
read-when: anytime
type: reference
---
# Doc ${i}`
      );
    }

    const bus = new EventBus();
    const errors: any[] = [];
    bus.subscribe("ERROR_OCCURRED", (envelope) => {
      errors.push(envelope.payload);
    });

    const limits = fakeLimits({ "docs.maxFiles": 3 });
    const manuals = new Manuals({ bus, limits });

    await manuals.registerDir(docsDir, "core");

    // At most 3 files should be registered
    const registered = manuals.list().filter((m) => m.id.startsWith("core/"));
    expect(registered.length).toBeLessThanOrEqual(3);

    // ERROR_OCCURRED should have been emitted about the cap
    expect(errors.some((e) => e.message.includes("Maximum file count"))).toBe(true);
  });

  it("uses default limits when limits port is not provided", async () => {
    const tmpDir = hermeticTmp("manuals-default-limits");
    const docsDir = path.join(tmpDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    // Create a doc file
    await fs.writeFile(
      path.join(docsDir, "guide.md"),
      `---
summary: Guide
read-when: anytime
type: reference
---
# Guide`
    );

    const bus = new EventBus();
    const manuals = new Manuals({ bus }); // No limits port

    const result = await manuals.registerDir(docsDir, "core");

    // Should succeed even without limits port
    expect(result).toBeUndefined();
    expect(manuals.list().some((m) => m.id === "core/guide")).toBe(true);
  });

  it("respects both maxFiles and maxFileBytes together", async () => {
    const tmpDir = hermeticTmp("manuals-combined-limits");
    const docsDir = path.join(tmpDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    // Create 5 small files
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        path.join(docsDir, `small${i}.md`),
        `---
summary: Small ${i}
read-when: anytime
type: reference
---
# Content`
      );
    }

    const bus = new EventBus();
    const errors: any[] = [];
    bus.subscribe("ERROR_OCCURRED", (envelope) => {
      errors.push(envelope.payload);
    });

    // Limit to 2 files max
    const limits = fakeLimits({ "docs.maxFiles": 2, "docs.maxFileBytes": 262144 });
    const manuals = new Manuals({ bus, limits });

    await manuals.registerDir(docsDir, "core");

    // Should have at most 2 registered
    const registered = manuals.list().filter((m) => m.id.startsWith("core/"));
    expect(registered.length).toBeLessThanOrEqual(2);
  });

  it("reports ERROR_OCCURRED once for skipped docs across the batch", async () => {
    const tmpDir = hermeticTmp("manuals-single-error");
    const docsDir = path.join(tmpDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    // Create many small files that will exceed the count limit
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(
        path.join(docsDir, `doc${i}.md`),
        `---
summary: Doc ${i}
read-when: anytime
type: reference
---
# Content`
      );
    }

    const bus = new EventBus();
    const errors: any[] = [];
    bus.subscribe("ERROR_OCCURRED", (envelope) => {
      errors.push(envelope.payload);
    });

    const limits = fakeLimits({ "docs.maxFiles": 2 });
    const manuals = new Manuals({ bus, limits });

    await manuals.registerDir(docsDir, "core");

    // Error should be reported only once
    const skipErrors = errors.filter((e) => e.message.includes("Skipped docs"));
    expect(skipErrors.length).toBe(1);
  });
});
