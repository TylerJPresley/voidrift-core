/**
 * The seeded worker prompts carry the stop-and-report rule (core-blueprint.md
 * §3.1): once its question is answered a worker stops and reports what is still
 * missing rather than widening the search. Reads the REAL shipped seed files.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { seedAgentsDir } from "./boot.js";

describe("seeded worker prompts — stop rule (§3.1)", () => {
  for (const worker of ["researcher", "implementer"]) {
    it(`${worker} prompt tells the worker to stop and report what is missing`, async () => {
      const file = path.join(seedAgentsDir(), worker, "prompt.md");
      const text = await fs.readFile(file, "utf8");
      expect(text).toContain("stop and report what is still missing");
    });
  }
});
