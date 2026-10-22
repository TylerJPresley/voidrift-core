/**
 * Session export — the sanitize pipeline + renderings (core-blueprint.md §10.13).
 *
 * Pure/deterministic: `buildSessionExport` assembles ONE sanitized value and
 * `renderJson`/`renderMarkdown` project it, so the two formats never diverge and
 * a secret masked in one is masked in both. Drives the §10.13 integration path
 * at the use-case boundary: a secret in a tool argument, an absolute home/
 * workspace path, a bidi-override character, an image attachment, a priced and
 * an unpriced turn, a journaled write → one document.
 */
import { describe, it, expect } from "vitest";
import {
  buildSessionExport,
  renderJson,
  renderMarkdown,
  EXPORT_LIMITS,
  type RawExportInput,
} from "./session-export.js";

const HOME = "/home/alice";
const WORKSPACE = "/home/alice/project";

function baseInput(overrides: Partial<RawExportInput> = {}): RawExportInput {
  return {
    session: {
      id: "abcd1234",
      name: "my session",
      agent: "chat",
      createdAt: "2026-10-19T00:00:00.000Z",
      lastActiveAt: "2026-10-19T01:00:00.000Z",
      turns: 2,
    },
    models: ["local"],
    totals: { tokensIn: 100, tokensOut: 50 },
    messages: [],
    home: HOME,
    workspaceRoot: WORKSPACE,
    ...overrides,
  };
}

describe("§10.13 — buildSessionExport sanitize pipeline", () => {
  it("masks a secret in a tool argument and counts it", () => {
    const input = baseInput({
      messages: [
        {
          role: "assistant",
          turn: 1,
          time: "2026-10-19T00:30:00.000Z",
          text: "running a command",
          toolCalls: [
            {
              tool: "execute_command",
              args: { command: "curl -H 'Authorization: Bearer sk-abc" + "def0123456789abcdef' https://api.example.com" },
            },
          ],
        },
      ],
    });
    const doc = buildSessionExport(input, true);
    const json = renderJson(doc);
    expect(json).not.toContain("sk-abc" + "def0123456789abcdef");
    expect(json).toContain("«redacted:");
    // Counted in masking.secrets.
    const totalSecrets = Object.values(doc.masking.secrets).reduce((a, b) => a + b, 0);
    expect(totalSecrets).toBeGreaterThanOrEqual(1);
  });

  it("rewrites home → ~ and workspace → <workspace> (longest-first) and counts", () => {
    const input = baseInput({
      messages: [
        {
          role: "assistant",
          turn: 1,
          time: "t",
          text: `edited ${WORKSPACE}/src/a.ts and read ${HOME}/.bashrc`,
        },
      ],
    });
    const doc = buildSessionExport(input, true);
    expect(doc.messages[0]!.text).toContain("<workspace>/src/a.ts");
    expect(doc.messages[0]!.text).toContain("~/.bashrc");
    expect(doc.messages[0]!.text).not.toContain(WORKSPACE);
    expect(doc.masking.pathsRewritten).toBe(2);
  });

  it("strips a bidi-override character from a user message and counts it", () => {
    const input = baseInput({
      messages: [{ role: "user", turn: 1, time: "t", text: "hello\u202Eworld" }],
    });
    const doc = buildSessionExport(input, true);
    expect(doc.messages[0]!.text).toBe("helloworld");
    expect(doc.masking.unsafeStripped).toBe(1);
  });

  it("renders an image as a {type,bytes} placeholder, never bytes", () => {
    const input = baseInput({
      messages: [{ role: "user", turn: 1, time: "t", text: "see image", images: [{ type: "png", bytes: 2048 }] }],
    });
    const doc = buildSessionExport(input, true);
    expect(doc.messages[0]!.images).toEqual([{ type: "png", bytes: 2048 }]);
    const md = renderMarkdown(doc);
    expect(md).toContain("image: png (2048 bytes)");
  });

  it("cost rides only when every model that ran is priced", () => {
    const priced = buildSessionExport(baseInput({ totals: { tokensIn: 100, tokensOut: 50, cost: 0.0015 } }), true);
    expect(priced.totals.cost).toBe(0.0015);
    const unpriced = buildSessionExport(baseInput({ totals: { tokensIn: 100, tokensOut: 50 } }), true);
    expect(unpriced.totals.cost).toBeUndefined();
    expect(renderMarkdown(unpriced)).not.toContain("cost");
  });

  it("includes a journaled write as sanitized metadata with no content", () => {
    const input = baseInput({
      writes: [
        { turn: 1, time: "t", tool: "write_file", intent: "add file", target: `${WORKSPACE}/x.ts`, result: "ok", undoHint: "restore" },
      ],
    });
    const doc = buildSessionExport(input, true);
    expect(doc.writes).toHaveLength(1);
    expect(doc.writes![0]!.target).toBe("<workspace>/x.ts");
    expect(doc.writes![0]!.result).toBe("ok");
    expect(JSON.stringify(doc.writes)).not.toContain("before");
  });

  it("JSON and Markdown come from the SAME sanitized value", () => {
    const input = baseInput({
      messages: [
        { role: "assistant", turn: 1, time: "t", text: `secret token ghp_01` + `23456789abcdefghijklmnopqrstuvwxyz and ${HOME}/x` },
      ],
    });
    const doc = buildSessionExport(input, true);
    const json = renderJson(doc);
    const md = renderMarkdown(doc);
    for (const out of [json, md]) {
      expect(out).not.toContain("ghp_01" + "23456789abcdefghijklmnopqrstuvwxyz");
      expect(out).toContain("~/x");
    }
  });

  it("--no-tool-results omits result bodies but keeps the call", () => {
    const input = baseInput({
      messages: [
        {
          role: "assistant",
          turn: 1,
          time: "t",
          text: "",
          toolCalls: [{ tool: "read_file", args: { path: "a.ts" }, result: { summary: "file body here", truncated: false } }],
        },
      ],
    });
    const doc = buildSessionExport(input, false);
    expect(doc.messages[0]!.toolCalls![0]!.tool).toBe("read_file");
    expect(doc.messages[0]!.toolCalls![0]!.result).toBeUndefined();
  });

  it("clips an over-bound tool result, marks it truncated, and counts it", () => {
    const big = "A".repeat(EXPORT_LIMITS.perResultBytes + 100);
    const input = baseInput({
      messages: [
        {
          role: "assistant",
          turn: 1,
          time: "t",
          text: "",
          toolCalls: [{ tool: "read_file", args: { path: "a.ts" }, result: { summary: big, truncated: false } }],
        },
      ],
    });
    const doc = buildSessionExport(input, true);
    const res = doc.messages[0]!.toolCalls![0]!.result!;
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.summary, "utf8")).toBeLessThanOrEqual(EXPORT_LIMITS.perResultBytes);
    expect(doc.masking.truncatedResults).toBe(1);
  });

  it("rewrites a prefix only at a path boundary, not mid-segment (finding 2)", () => {
    // '/home/alice2/...' must NOT become '~2/...' and a prefixed occurrence
    // 'prefix/home/alice/x' must NOT become 'prefix~/x'. Only a real boundary
    // match rewrites, and only those are counted.
    const input = baseInput({
      messages: [
        {
          role: "assistant",
          turn: 1,
          time: "t",
          text: `sibling /home/alice2/secret and embedded prefix${HOME}/x and real ${HOME}/ok and exact ${HOME}`,
        },
      ],
    });
    const doc = buildSessionExport(input, true);
    const text = doc.messages[0]!.text;
    expect(text).toContain("/home/alice2/secret"); // sibling untouched
    expect(text).toContain(`prefix${HOME}/x`); // non-boundary prefix untouched
    expect(text).toContain("real ~/ok"); // boundary match rewritten
    expect(text).toMatch(/exact ~($|\s)/); // end-of-string match rewritten
    // Only the two real boundary matches counted.
    expect(doc.masking.pathsRewritten).toBe(2);
  });

  it("fences multi-line untrusted message text so it cannot break structure or inject HTML (finding 1)", () => {
    const input = baseInput({
      messages: [
        {
          role: "assistant",
          turn: 1,
          time: "t",
          text: "line one\n## not a real heading\n```\nfake fence\n```\n<script>alert(1)</script>",
        },
      ],
    });
    const doc = buildSessionExport(input, true);
    const md = renderMarkdown(doc);
    const lines = md.split("\n");
    // The injected heading line exists but sits INSIDE a fenced block (inert
    // code), not as a top-level Markdown heading. Find the fence that opens
    // before it and the one that closes after it.
    const headingIdx = lines.findIndex((l) => l === "## not a real heading");
    expect(headingIdx).toBeGreaterThan(-1);
    const fenceOpen = [...lines.slice(0, headingIdx)].reverse().findIndex((l) => /^`{3,}$/.test(l));
    const fenceAfter = lines.slice(headingIdx + 1).findIndex((l) => /^`{3,}$/.test(l));
    expect(fenceOpen).toBeGreaterThan(-1); // a fence opens before it
    expect(fenceAfter).toBeGreaterThan(-1); // a fence closes after it
    // The fence is longer than the content's own backtick run (content has ```).
    expect(md).toContain("````");
    // The script tag is preserved verbatim INSIDE the fence (inert), not raw HTML.
    expect(md).toContain("<script>alert(1)</script>");
  });

  it("renders one-line untrusted values (write target/intent, event lines) safely (finding 1)", () => {
    const input = baseInput({
      writes: [
        { turn: 1, time: "t", tool: "write_file", intent: "`inject` <b>", target: `${WORKSPACE}/a.ts`, result: "ok" },
      ],
      messages: [
        { role: "assistant", turn: 1, time: "t", text: "", events: [{ kind: "plan", line: "step `x` <i>tag</i>" }] },
      ],
    });
    const doc = buildSessionExport(input, true);
    const md = renderMarkdown(doc);
    // Inline untrusted values are wrapped as inline code spans (dynamic backtick
    // count) or escaped, so the raw angle-bracket HTML does not appear unescaped.
    expect(md).not.toMatch(/-\s*plan:\s*step `x` <i>tag<\/i>\s*$/m);
  });

  it("JSON output is unchanged by the Markdown hardening (finding 1)", () => {
    const input = baseInput({
      messages: [{ role: "assistant", turn: 1, time: "t", text: "## heading\n```fence```\n<script>" }],
    });
    const doc = buildSessionExport(input, true);
    const json = JSON.parse(renderJson(doc)) as { messages: { text: string }[] };
    // JSON carries the sanitized text verbatim (no fencing/escaping applied).
    expect(json.messages[0]!.text).toBe("## heading\n```fence```\n<script>");
  });

  it("masking and stripping are idempotent (re-exporting a document is stable)", () => {
    const input = baseInput({
      messages: [{ role: "assistant", turn: 1, time: "t", text: `aws AKIAIO` + `SFODNN7EXAMPLE at ${WORKSPACE}` }],
    });
    const once = buildSessionExport(input, true);
    const twice = buildSessionExport(
      { ...input, messages: [{ role: "assistant", turn: 1, time: "t", text: once.messages[0]!.text }] },
      true,
    );
    expect(twice.messages[0]!.text).toBe(once.messages[0]!.text);
  });
});
