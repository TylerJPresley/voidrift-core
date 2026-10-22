/**
 * The core's 16 built-in datasets (core-blueprint.md §12.7, panels §4).
 *
 * A dataset is the ONE read-only data seam behind every panel: pure data
 * (`description`, `fields`) plus a zero-argument `rows()` reader of plain
 * JSON-serializable objects. The core registers these at startup from its OWN
 * services, so EVERY client (CLI, VS Code, desktop, web) reads the same rows;
 * a product registers panels, never the built-in datasets (§12.7).
 *
 * Each `rows()` closure reads the live data through the SAME public CoreAPI
 * surface a client would call (`api.session.list()`, `api.models.list()`, …) and
 * shapes each row to the stable field names the panels bind — the per-op shaping
 * that used to live in the CLI's `snapshotOp` (cli `core-client.ts`) lives HERE
 * now, so the shape is defined once and shared. Row secret-masking, the row/size
 * caps and the `RESOURCE_CHANGED` refresh are all the facade's `datasets.rows`
 * job (§12.7, §10.10); this module only shapes.
 *
 * A dataset whose capability is a disabled plugin is absent — the Plan plugin
 * registers its OWN `plan` dataset through its register context (§12.7), so it
 * is present only when the plugin is enabled; it is never seeded here.
 */
import type { CoreAPI } from "../facade.js";
import type { Row, DatasetDeclaration } from "../entities/registry/dataset-schema.js";

/** Narrow a value to a plain record for defensive field access. */
const rec = (x: unknown): Record<string, unknown> => (x ?? {}) as Record<string, unknown>;

/** Unwrap a `Result<T[]>`-returning op to its array, or `[]` on error/non-array. */
async function okRows(p: Promise<{ ok: boolean; value?: unknown }>): Promise<unknown[]> {
  try {
    const r = await p;
    return r.ok && Array.isArray(r.value) ? (r.value as unknown[]) : [];
  } catch {
    return [];
  }
}

/** Unwrap a `Result<T>`-returning op to its value, or `undefined` on error. */
async function okValue<T>(p: Promise<{ ok: boolean; value?: unknown }>): Promise<T | undefined> {
  try {
    const r = await p;
    return r.ok ? (r.value as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Round a number for display; integers print bare, else one decimal. */
function n(v: number): string {
  if (!Number.isFinite(v)) return "0";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Project a `StatsReport` into `{label,value}` rows for the `stats` panel
 * (§10.14, §7.2) — ported verbatim from the CLI's `statsPanelRows` so the stats
 * panel shows exactly what it did: a tokens block, turns, tool calls/errors,
 * wall time, tokens/second, the money column only when priced, and the
 * by-model/by-agent rollup. An estimated bucket is marked `~`.
 */
function statsRows(report: Record<string, unknown>): Row[] {
  const t = rec(report["totals"]);
  const num = (k: string): number => (typeof t[k] === "number" ? (t[k] as number) : 0);
  const est = num("estimatedTurns") > 0;
  const estMark = est ? " ~" : "";
  const cost = typeof t["cost"] === "number" ? (t["cost"] as number) : undefined;
  const tps = typeof t["tokensPerSecond"] === "number" ? (t["tokensPerSecond"] as number) : undefined;
  const rows: Row[] = [
    { label: "turns", value: `${n(num("turns"))}${est ? ` (${n(num("estimatedTurns"))} est)` : ""}` },
    { label: "tool calls", value: n(num("toolCalls")) },
    { label: "tool errors", value: n(num("toolErrors")) },
    { label: "tokens in", value: `${n(num("tokensIn"))}${estMark}` },
    { label: "tokens out", value: `${n(num("tokensOut"))}${estMark}` },
    { label: "tokens cache-read", value: n(num("tokensCacheRead")) },
    { label: "tokens total", value: `${n(num("tokensTotal"))}${estMark}` },
    { label: "wall time (ms)", value: n(num("wallMs")) },
    { label: "tokens/second", value: tps !== undefined ? n(tps) : "—" },
    { label: "cost", value: cost !== undefined ? `$${cost.toFixed(4)}` : "(no price configured)" },
  ];
  const roll = (prefix: string, key: string, withTurns: boolean): void => {
    const map = rec(report[key]);
    for (const k of Object.keys(map).sort()) {
      const b = rec(map[k]);
      const bt = typeof b["tokensTotal"] === "number" ? (b["tokensTotal"] as number) : 0;
      const turns = typeof b["turns"] === "number" ? (b["turns"] as number) : 0;
      const bc = typeof b["cost"] === "number" ? (b["cost"] as number) : undefined;
      const money = withTurns && bc !== undefined ? `, $${bc.toFixed(4)}` : "";
      rows.push({ label: `${prefix}: ${k}`, value: `${n(bt)} tok, ${n(turns)} turns${money}` });
    }
  };
  roll("model", "byModel", true);
  roll("agent", "byAgent", false);
  return rows;
}

/**
 * The 16 built-in dataset declarations keyed by name (§12.7). Each `rows()` is a
 * zero-argument reader over the public CoreAPI. The shapes mirror the former CLI
 * `snapshotOp` so panels bind unchanged.
 */
export function builtinDatasets(api: CoreAPI): Record<string, DatasetDeclaration> {
  return {
    sessions: {
      description: "Stored sessions — name, id, last active, and summary.",
      fields: [
        { key: "name", label: "Name" },
        { key: "id", label: "Id" },
        { key: "lastActiveAt", label: "Last active", format: "relative-time" },
        { key: "summary", label: "Summary" },
      ],
      rows: async () =>
        (await api.session.list()).map((s) => {
          const r = rec(s);
          return { name: r["name"] ?? "", id: r["id"] ?? "", lastActiveAt: r["lastActiveAt"] ?? "", summary: r["summary"] ?? "" };
        }),
    },

    models: {
      description: "Configured model endpoints — name, model id, protocol, and the active one.",
      fields: [
        { key: "name", label: "Name" },
        { key: "model", label: "Model" },
        { key: "protocol", label: "Protocol" },
        { key: "active", label: "Active" },
      ],
      rows: async () =>
        (await okRows(api.models.list())).map((m) => {
          const r = rec(m);
          return { name: r["name"] ?? "", model: r["model"] ?? "", protocol: r["protocol"] ?? "", active: r["active"] === true ? "yes" : "" };
        }),
    },

    agents: {
      description: "Registered agents — name and description.",
      fields: [
        { key: "name", label: "Name" },
        { key: "description", label: "Description" },
      ],
      rows: async () =>
        (await okRows(api.agents.list())).map((a) => {
          const r = rec(a);
          return { name: r["name"] ?? "", description: r["description"] ?? "" };
        }),
    },

    tools: {
      description: "The active agent's effective tools — name, origin, access, and description.",
      fields: [
        { key: "name", label: "Name" },
        { key: "origin", label: "Origin" },
        { key: "status", label: "Access" },
        { key: "description", label: "Description" },
      ],
      rows: async () =>
        (await okRows(api.agents.tools())).map((t) => {
          const r = rec(t);
          const status = r["status"] === "allow" ? "allow-listed" : r["status"] ? "asks" : "";
          return { name: r["name"] ?? "", origin: r["origin"] ?? "builtin", status, description: r["description"] ?? "" };
        }),
    },

    mcp: {
      description: "MCP servers and their tools — server, status, tool count, and detail.",
      fields: [
        { key: "name", label: "Server" },
        { key: "status", label: "Status" },
        { key: "toolCount", label: "Tools", format: "count" },
        { key: "detail", label: "Detail" },
      ],
      rows: async () =>
        (await okRows(api.mcp.list())).flatMap((m) => {
          const r = rec(m);
          const server = String(r["name"] ?? "");
          const toolStatuses = Array.isArray(r["toolStatuses"]) ? (r["toolStatuses"] as unknown[]) : [];
          const toolCount = r["toolCount"] ?? (Array.isArray(r["tools"]) ? (r["tools"] as unknown[]).length : toolStatuses.length);
          // The server row, then one row per tool carrying its pin state and
          // reason. Every row carries `server` so the approve action can target
          // the server whether a server or a tool row is selected (§12.7, panels §4).
          const serverRow: Row = {
            name: server,
            status: r["status"] ?? "",
            toolCount,
            detail: r["error"] ? String(r["error"]) : "",
            server,
          };
          const toolRows: Row[] = toolStatuses.map((t) => {
            const tr = rec(t);
            const reason = tr["reason"] ? ` — ${String(tr["reason"])}` : "";
            return {
              name: `  ${String(tr["name"] ?? "")}`,
              status: String(tr["status"] ?? ""),
              toolCount: "",
              detail: `${String(tr["status"] ?? "")}${reason}`,
              server,
            };
          });
          return [serverRow, ...toolRows];
        }),
    },

    plugins: {
      description: "Loaded plugins — id, enabled state, and scope.",
      fields: [
        { key: "id", label: "Plugin" },
        { key: "enabled", label: "Enabled" },
        { key: "scope", label: "Scope" },
      ],
      rows: async () =>
        (await okRows(api.plugins.list())).map((p) => {
          const r = rec(p);
          return { id: r["id"] ?? "", enabled: r["enabled"] === true ? "yes" : "no", scope: r["scope"] ?? "" };
        }),
    },

    permissions: {
      description: "The permission allow-list rules — pattern, decision, and scope.",
      fields: [
        { key: "pattern", label: "Pattern" },
        { key: "decision", label: "Decision" },
        { key: "scope", label: "Scope" },
      ],
      rows: async () =>
        (await okRows(api.permissions.rules())).map((p) => {
          const r = rec(p);
          return { pattern: r["pattern"] ?? r["match"] ?? "", decision: r["decision"] ?? r["effect"] ?? "", scope: r["scope"] ?? r["source"] ?? "" };
        }),
    },

    compliance: {
      description: "Compliance (Warden) status, policies, and recent decisions.",
      fields: [
        { key: "label", label: "Item" },
        { key: "detail", label: "Detail" },
      ],
      // One dataset for all three sections, each row tagged with a `_section`
      // field so a panel can tab them via `pages` in memory (§12.7, proposal 4a).
      rows: async () => {
        const out: Row[] = [];
        const status = await okValue<Record<string, unknown>>(api.compliance.status());
        if (status) out.push({ _section: "status", label: "status", detail: String(status["mode"] ?? status["status"] ?? JSON.stringify(status)) });
        for (const p of await okRows(api.compliance.policies())) {
          const r = rec(p);
          out.push({ _section: "policies", label: `policy: ${String(r["name"] ?? r["id"] ?? "")}`, detail: r["description"] ?? "" });
        }
        for (const d of await okRows(api.compliance.decisions())) {
          const r = rec(d);
          out.push({
            _section: "decisions",
            label: `decision: ${String(r["action"] ?? r["pattern"] ?? "")}`,
            detail: `${String(r["outcome"] ?? r["decision"] ?? "")} ${String(r["policy"] ?? "")}`.trim(),
          });
        }
        return out;
      },
    },

    memory: {
      description: "Durable memory entries — kind, title, and detail.",
      fields: [
        { key: "kind", label: "Kind" },
        { key: "title", label: "Title" },
        { key: "detail", label: "Detail" },
      ],
      rows: async () =>
        (await okRows(api.memory.list())).map((e) => {
          const r = rec(e);
          return { id: r["id"] ?? "", kind: String(r["type"] ?? "memory"), title: r["title"] ?? "", detail: r["scope"] ?? r["summary"] ?? "" };
        }),
    },

    "memory-suggestions": {
      description: "Pending memory suggestions awaiting approval — title and status.",
      fields: [
        { key: "kind", label: "Kind" },
        { key: "title", label: "Title" },
        { key: "detail", label: "Detail" },
      ],
      rows: async () =>
        (await okRows(api.memory.suggestions.list())).map((s) => {
          const r = rec(s);
          // `id` lets the approve/reject actions target the row (§12.7, panels §4).
          return { id: r["id"] ?? "", kind: "suggestion", title: r["title"] ?? "", detail: r["status"] ?? "pending" };
        }),
    },

    skills: {
      description: "Loaded skills — name, scope, and description.",
      fields: [
        { key: "name", label: "Name" },
        { key: "scope", label: "Scope" },
        { key: "description", label: "Description" },
      ],
      rows: async () =>
        (await okRows(api.skills.list())).map((s) => {
          const r = rec(s);
          return { name: r["name"] ?? "", scope: r["scope"] ?? "", description: r["description"] ?? "" };
        }),
    },

    prompts: {
      description: "Registered prompts — key and label.",
      fields: [
        { key: "key", label: "Key" },
        { key: "label", label: "Label" },
      ],
      rows: async () =>
        (await okRows(api.prompts.list())).map((p) => {
          const r = rec(p);
          return { key: r["key"] ?? "", label: r["label"] ?? r["description"] ?? "" };
        }),
    },

    stats: {
      description: "The live session's token, turn, tool and time stats.",
      fields: [
        { key: "label", label: "Metric" },
        { key: "value", label: "Value" },
      ],
      rows: async () => {
        const report = await okValue<Record<string, unknown>>(api.models.stats());
        return report ? statsRows(report) : [];
      },
    },

    context: {
      description: "The live session's context-window breakdown by segment.",
      fields: [
        { key: "label", label: "Segment" },
        { key: "value", label: "Value" },
      ],
      rows: async () => {
        const sessionId = api.activeSessionId();
        if (!sessionId) return [];
        const v = await okValue<Record<string, unknown>>(api.models.context(sessionId));
        if (!v) return [];
        return Object.entries(v).map(([k, val]) => ({ label: k, value: typeof val === "object" ? JSON.stringify(val) : String(val) }));
      },
    },

    diff: {
      description: "The working-tree diff, one row per line.",
      fields: [{ key: "line", label: "Working-tree diff" }],
      rows: async () => {
        const v = await okValue<string>(api.workspace.diff());
        return typeof v === "string" && v.length > 0 ? v.split("\n").map((line) => ({ line })) : [];
      },
    },

    commands: {
      description: "Registered core and plugin commands — name and description.",
      fields: [
        { key: "name", label: "Command" },
        { key: "description", label: "Description" },
      ],
      // The core's own commands (core/plugin-registered names, §14). A client's
      // own built-in slash commands (the CLI's §7.3 set) are a CLIENT concern,
      // merged into its view-model — the core knows only what it registered.
      rows: async () => {
        const names = await okValue<string[]>(api.session.listCommands());
        return (names ?? []).map((name) => ({ name: `/${name}`, description: "" }));
      },
    },
  };
}

/**
 * Register the 16 built-in datasets at startup (§12.7). Called from `createCore`
 * AFTER the services and CoreAPI exist, through the SAME `register.dataset` seam
 * a plugin uses (so the core validates each and stores it under
 * `datasets.{name}`). A product registers panels, never these.
 */
export function registerBuiltinDatasets(
  api: CoreAPI,
  register: (name: string, declaration: DatasetDeclaration) => unknown,
): void {
  for (const [name, declaration] of Object.entries(builtinDatasets(api))) {
    register(name, declaration);
  }
}
