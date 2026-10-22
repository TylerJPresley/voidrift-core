/**
 * Agents directory adapter (core-blueprint.md §3.1, §7.1, §12.1).
 *
 * Discovers JSON agent DIRECTORIES across the two filesystem cascade sources —
 * the project `<workdir>/.voidrift/agents/` dir and the global
 * `~/.config/voidrift/agents/` dir. Each agent is a directory `<name>/` holding
 * `agent.json` plus an optional sibling `prompt.md`. The manifest parses and
 * validates with the entity's `parseAgentManifest` (JSON + Zod), and a malformed
 * directory is SKIPPED so discovery never breaks (§12.1). The built-in `chat`
 * lives in CODE (`entities/builtin-chat.ts`), not on disk — the runtime never
 * reads the core package's own folder. It is the adapter behind
 * `AgentDiscoveryPort`; a fake implements the same port in tests (§1 rule 7).
 *
 * Containment (§1 rule 3, §8.2): the PROJECT source is read through the
 * workspace-confined `FileSystemPort`. The GLOBAL source lives OUTSIDE the
 * workspace (`~/.config/voidrift`), which the workspace-confined port can never
 * reach, so — exactly like the obs log store's `globalFs` (boot.ts, §10.3) — it
 * is read through a dedicated GLOBAL-ROOTED `FileSystemPort` addressed relative
 * to it (default `"agents"`). Both remain injectable for tests.
 */
import path from "node:path";
import type { FileSystemPort } from "../entities/ports/host.js";
import {
  parseAgentManifest,
  AgentManifestError,
  type AgentDiscoveryPort,
  type AgentDiscoveryResult,
  type AgentSource,
} from "../entities/agent-manifest.js";

export interface AgentDirRoots {
  /** The project agents dir relative to the workspace FS, e.g. `.voidrift/agents`. */
  project: string;
  /**
   * The global agents dir, RELATIVE to `globalFs` (default `"agents"`, i.e.
   * `~/.config/voidrift/agents`). The global dir is outside the workspace, so it
   * is read through the dedicated `globalFs` port rather than the
   * workspace-confined one.
   */
  global: string;
}

export class AgentsDirectory implements AgentDiscoveryPort {
  /**
   * @param fs       the PROJECT/workspace-rooted FileSystemPort (§8.2).
   * @param roots    the two filesystem cascade source locations.
   * @param globalFs a dedicated GLOBAL-rooted FileSystemPort (e.g.
   *   `FilesystemAdapter(voidriftConfigDir())`), used so the global agents dir —
   *   which sits outside the workspace — is reachable.
   */
  constructor(
    private readonly fs: FileSystemPort,
    private readonly roots: AgentDirRoots,
    private readonly globalFs?: FileSystemPort,
  ) {}

  /**
   * Discover and validate every agent directory under a source (§3.1). The
   * built-in `chat` is NOT discovered here (it lives in code); `builtin` returns
   * nothing. Each definition is tagged with its `source` for the cascade and
   * `agents.list` reporting.
   */
  async discover(source: AgentSource): Promise<AgentDiscoveryResult> {
    if (source === "builtin") return { definitions: [], skipped: [] };
    if (source === "global") {
      if (!this.globalFs) return { definitions: [], skipped: [] };
      return this.discoverThroughPort(this.globalFs, this.roots.global, "global");
    }
    return this.discoverThroughPort(this.fs, this.roots.project, "project");
  }

  /** Discover a source through a `FileSystemPort` rooted so `root` is reachable.
   * Each `<root>/<name>/agent.json` is one agent; the sibling `prompt.md` is read
   * when present. A directory whose manifest fails to parse/validate is skipped. */
  private async discoverThroughPort(
    port: FileSystemPort,
    root: string,
    source: AgentSource,
  ): Promise<AgentDiscoveryResult> {
    const manifests = await port.glob(path.join(root, "*", "agent.json")).catch(() => [] as string[]);
    const definitions = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const manifestPath of manifests.sort()) {
      const dirName = path.basename(path.dirname(manifestPath));
      try {
        const raw = await port.readFile(manifestPath);
        const promptPath = path.join(path.dirname(manifestPath), "prompt.md");
        const promptMd = await port.readFile(promptPath).catch(() => undefined);
        definitions.push({ ...parseAgentManifest(raw, dirName, promptMd), source, filePath: manifestPath });
      } catch (e) {
        const reason = e instanceof AgentManifestError ? e.message : String(e);
        skipped.push({ name: dirName, reason });
      }
    }
    return { definitions, skipped };
  }
}
