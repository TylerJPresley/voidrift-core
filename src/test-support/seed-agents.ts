/**
 * Test helper: copy the package's SEED agent templates into a target directory.
 *
 * The runtime NEVER reads the package's `seed/` folder (§3.1): seeding is
 * A2/`config.init`'s job. Until then, tests that need the default agents
 * (research, vibe, researcher, planner, implementer, reviewer, summarizer) present in a
 * user folder COPY them from `seed/agents/*` into a temp global or project
 * `agents/` dir with this helper — exactly the data `config.init` will later
 * write.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package's seed agents dir, resolved relative to THIS module so it works
 * from `src` (tests) and from the installed `dist` alike — both sit two levels
 * below the package root, so `../../seed/agents` resolves either way. */
export function seedAgentsDir(): string {
  return fileURLToPath(new URL("../../seed/agents/", import.meta.url));
}

/** The names of the agents the package seeds (§0.2): two top-level + five workers. */
export const SEED_AGENT_NAMES = ["implementer", "planner", "research", "researcher", "reviewer", "summarizer", "vibe"] as const;

/**
 * Copy every seed agent directory (`<name>/agent.json` + `prompt.md`) into
 * `targetAgentsDir` (e.g. a temp `~/.config/voidrift/agents` or
 * `<ws>/.voidrift/agents`). Creates the target if missing. Mirrors what
 * `config.init` will write in A2.
 */
export function seedAgentsInto(targetAgentsDir: string): void {
  const src = seedAgentsDir();
  fs.mkdirSync(targetAgentsDir, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const srcDir = path.join(src, name);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(targetAgentsDir, name);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
    }
  }
}
