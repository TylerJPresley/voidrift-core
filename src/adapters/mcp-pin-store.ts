/**
 * The filesystem MCP pin store adapter (core-blueprint.md §8.4).
 *
 * Persists `.voidrift/mcp-pins.json` through the one `FileSystemPort`
 * containment chokepoint and `writeFileAtomic` (temp-then-rename, mode 0600,
 * containing dir 0700) — the SAME primitive the evicted-result cache uses, so
 * atomicity, privacy, and workspace containment have one source of truth. The
 * record is never model-writable and never part of config.
 */
import type { FileSystemPort } from "../entities/ports/host.js";
import { emptyPinRecord, type McpPinRecord, type McpPinStore } from "../entities/mcp/mcp-pins.js";

/** The per-workspace pin file (workspace-relative; contained by the port). */
export const MCP_PINS_PATH = ".voidrift/mcp-pins.json";

export class FilesystemMcpPinStore implements McpPinStore {
  constructor(private readonly fs: FileSystemPort) {}

  async load(): Promise<McpPinRecord> {
    try {
      if (!(await this.fs.exists(MCP_PINS_PATH))) return emptyPinRecord();
      const text = await this.fs.readFile(MCP_PINS_PATH);
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { servers?: unknown }).servers !== "object") {
        return emptyPinRecord();
      }
      return parsed as McpPinRecord;
    } catch {
      // A corrupt or unreadable pin file is treated as no approvals: fail
      // closed (every tool pending/quarantined), never crash the client (§8.4).
      return emptyPinRecord();
    }
  }

  async save(record: McpPinRecord): Promise<void> {
    await this.fs.writeFileAtomic(MCP_PINS_PATH, JSON.stringify(record, null, 2), { mode: 0o600 });
  }
}
