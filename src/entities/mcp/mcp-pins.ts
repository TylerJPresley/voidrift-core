/**
 * MCP tool pinning (core-blueprint.md §8.4).
 *
 * Trust-on-first-use for an MCP server's TOOL DESCRIPTIONS. On first successful
 * listing the client records, per server and tool, a SHA-256 over the canonical
 * JSON of `{ name, description, inputSchema, annotations }` — computed by the ONE
 * hash utility (§8.2) — in a durable per-workspace pin record
 * `.voidrift/mcp-pins.json`, never model-writable and never part of config.
 *
 * Statuses (§8.4):
 *  - `pending`    — first seen, never approved. Unbound, uncallable.
 *  - `approved`   — pinned hash matches an approval. Bound and callable.
 *  - `quarantined`— the hash differs from the approved pin (a rug pull), OR a
 *                   new tool after the server was approved. Unbound, uncallable.
 *
 * A removed tool is dropped from the pins and reported. Pinning protects the
 * description channel; permissions come only from the allow list.
 *
 * This module is PURE: the canonical hash, the per-tool status evaluation, and
 * the diff an approval carries. The filesystem adapter satisfies `McpPinStore`.
 */
import { contentHash } from "../hash.js";
import { limitDefault } from "../limits.js";
import type { McpToolDescriptor, McpToolStatus } from "./mcp-types.js";

/** The maximum model-facing tool-description length (§8.4, §13.11 MCP2). A
 * hostile or oversized description is truncated and control characters are
 * stripped before the description is bound to the model. The default is the
 * registry limit `mcp.descriptionMaxChars`; the runtime passes the effective
 * (cascaded) value via {@link sanitizeDescription}'s `maxChars` argument. */
export const MCP_DESCRIPTION_MAX_CHARS = limitDefault("mcp.descriptionMaxChars");

/** One pinned tool: the content hash and whether the user/policy approved it. */
export interface McpToolPin {
  hash: string;
  status: "approved";
}

/** The durable pin record for one server (`.voidrift/mcp-pins.json` per server). */
export interface McpServerPins {
  tools: Record<string, McpToolPin>;
}

/** The whole pin record: server → its approved pins. */
export interface McpPinRecord {
  servers: Record<string, McpServerPins>;
}

/**
 * The pin store PORT (§8.4). Reads and writes `.voidrift/mcp-pins.json`
 * atomically, mode 0600, contained in the workspace. In tests an in-memory fake
 * satisfies it (§15.3).
 */
export interface McpPinStore {
  load(): Promise<McpPinRecord>;
  save(record: McpPinRecord): Promise<void>;
}

/** An empty pin record. */
export function emptyPinRecord(): McpPinRecord {
  return { servers: {} };
}

/**
 * Canonical JSON with sorted keys at every object level — a stable serialization
 * so the hash is independent of key order (§8.4). Arrays keep order (they are
 * ordered data); objects are key-sorted recursively.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The pin hash over `{ name, description, inputSchema, annotations }` (§8.4),
 * computed through the ONE hash utility (§8.2). Annotations are the untrusted
 * display hints the server declared; a change to any of them re-pins.
 */
export function pinHash(d: McpToolDescriptor): string {
  const annotations = {
    readOnlyHint: d.readOnlyHint,
    ...(d.destructiveHint !== undefined ? { destructiveHint: d.destructiveHint } : {}),
    ...(d.idempotentHint !== undefined ? { idempotentHint: d.idempotentHint } : {}),
    ...(d.openWorldHint !== undefined ? { openWorldHint: d.openWorldHint } : {}),
    ...(d.title !== undefined ? { title: d.title } : {}),
  };
  const canonical = canonicalJson({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema ?? {},
    annotations,
  });
  return contentHash(canonical);
}

/** The evaluated status of one tool against the server's pins (§8.4). */
export interface EvaluatedTool {
  descriptor: McpToolDescriptor;
  hash: string;
  status: McpToolStatus;
  reason?: string;
}

/** The result of evaluating a listing against the pins (§8.4). */
export interface PinEvaluation {
  tools: EvaluatedTool[];
  /** Tool names whose approved hash changed (a rug pull). */
  changed: string[];
  /** Tool names seen for the first time after the server had approvals. */
  added: string[];
  /** Previously-pinned tool names no longer listed (dropped, reported). */
  removed: string[];
  /** True when any tool quarantined or was removed — fire MCP_TOOLS_QUARANTINED. */
  quarantined: boolean;
}

/**
 * Evaluate a fresh listing against the server's approved pins (§8.4), PURE.
 *
 * - A tool whose hash matches its approved pin → `approved`.
 * - A tool whose hash differs from its approved pin → `quarantined` (changed).
 * - A tool with no pin, when the server has at least one approved pin → `added`
 *   → `quarantined` (a new tool after approval).
 * - A tool with no pin, when the server has NO approved pin yet → `pending`
 *   (trust-on-first-use: nothing is bound until `mcp.approve`).
 * - A previously-pinned tool absent from the listing → `removed` (dropped).
 */
export function evaluatePins(serverPins: McpServerPins | undefined, descriptors: McpToolDescriptor[]): PinEvaluation {
  const pins = serverPins?.tools ?? {};
  const hasApprovals = Object.keys(pins).length > 0;
  const listedNames = new Set(descriptors.map((d) => d.name));
  const tools: EvaluatedTool[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  let quarantined = false;

  for (const d of descriptors) {
    const hash = pinHash(d);
    const pin = pins[d.name];
    if (pin) {
      if (pin.hash === hash) {
        tools.push({ descriptor: d, hash, status: "approved" });
      } else {
        tools.push({ descriptor: d, hash, status: "quarantined", reason: "description or schema changed since approval" });
        changed.push(d.name);
        quarantined = true;
      }
    } else if (hasApprovals) {
      tools.push({ descriptor: d, hash, status: "quarantined", reason: "new tool added after approval" });
      added.push(d.name);
      quarantined = true;
    } else {
      tools.push({ descriptor: d, hash, status: "pending", reason: "awaiting first approval" });
    }
  }

  const removed = Object.keys(pins).filter((n) => !listedNames.has(n));
  if (removed.length) quarantined = true;

  return { tools, changed, added, removed, quarantined };
}

/** The per-tool diff an approval carries, descriptions MASKED by the caller. */
export interface ApprovalDiffEntry {
  name: string;
  change: "added" | "changed" | "removed";
  oldHash?: string;
  newHash?: string;
  description?: string;
}

/**
 * The full diff of a server's listing vs its current pins, for the approval
 * payload (§8.4). The caller masks description text through the one §10.10
 * detector before this leaves the process.
 */
export function approvalDiff(serverPins: McpServerPins | undefined, descriptors: McpToolDescriptor[]): ApprovalDiffEntry[] {
  const pins = serverPins?.tools ?? {};
  const listed = new Set(descriptors.map((d) => d.name));
  const entries: ApprovalDiffEntry[] = [];
  for (const d of descriptors) {
    const hash = pinHash(d);
    const pin = pins[d.name];
    if (!pin) entries.push({ name: d.name, change: "added", newHash: hash, description: d.description });
    else if (pin.hash !== hash) entries.push({ name: d.name, change: "changed", oldHash: pin.hash, newHash: hash, description: d.description });
  }
  for (const name of Object.keys(pins)) {
    if (!listed.has(name)) entries.push({ name, change: "removed", oldHash: pins[name]!.hash });
  }
  return entries;
}

/** Clean a description before binding to the model (§8.4): strip control chars
 * and cap length. A tool description is DATA, never authority (§1 rule 15). The
 * cap defaults to {@link MCP_DESCRIPTION_MAX_CHARS} (registry MCP2); the runtime
 * passes the effective cascaded value for `mcp.descriptionMaxChars`. */
export function sanitizeDescription(description: string, maxChars: number = MCP_DESCRIPTION_MAX_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const stripped = description.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped;
}
