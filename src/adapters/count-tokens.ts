/**
 * The exact pre-send token-count adapter (core-blueprint.md §4.8, §11.7).
 *
 * An OPTIONAL capability a protocol may expose: the context pipeline asks the
 * SELECTED endpoint for an exact input-token count only when the pre-flight
 * estimate lies within the estimate margin of a decision threshold (§4.8), and
 * uses it in place of the estimate for that one decision. It replaces nothing
 * else: most turns make no call.
 *
 * The bundled set wires it where the endpoint offers one — Anthropic
 * `count_tokens` and the OpenAI-compatible `/tokenize` (vLLM, llama.cpp) — and
 * leaves it unset elsewhere (Google, Bedrock). The call reaches ONLY the
 * selected endpoint's own `baseUrl` with its own key, follows NO redirects, and
 * is bounded by an internal 5-second timeout; it never fails over (§11.5,
 * invariant 26). A `null` return means the endpoint cannot count this request,
 * and the first failure marks the endpoint unsupported for the session (the
 * caller's concern, not this adapter's).
 */
import type { BaseMessage } from "@langchain/core/messages";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { ModelConfigEntry } from "../config/schema.js";
import type { ToolDefinition } from "../entities/tool-registry.js";

/** The internal request timeout for a count call (§4.8). Not a config key — an
 * internal constant, like the ratio clamp. */
export const COUNT_TOKENS_TIMEOUT_MS = 5000;

/** The default OpenAI-compatible base when an entry sets none (the public
 * OpenAI API offers no `/tokenize`, so a bundled cloud OpenAI entry with no
 * `baseUrl` is treated as unsupported — the caller gets `null`). */
function openAiTokenizeUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/tokenize`;
}

function anthropicCountUrl(baseUrl: string | undefined): string {
  const base = (baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return `${base}/v1/messages/count_tokens`;
}

/** Plain-text content of one message, for the OpenAI `/tokenize` prompt body. */
function textOf(m: BaseMessage): string {
  const c = m.content as unknown;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** Map a BaseMessage to the Anthropic role/content shape for count_tokens. */
function toAnthropicMessage(m: BaseMessage): { role: "user" | "assistant"; content: string } {
  const type = m.getType();
  const role: "user" | "assistant" = type === "ai" ? "assistant" : "user";
  return { role, content: textOf(m) };
}

/** The JSON Schema of a tool's input, the shape a bound request actually sends. */
function toolInputSchema(t: ToolDefinition): Record<string, unknown> {
  try {
    return toJsonSchema(t.schema as never) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Anthropic `count_tokens` accepts a `tools:` array of the same shape a request
 * binds (§4.8, §11.7), so the server counts the tool schemas exactly. */
function toAnthropicTools(tools: ToolDefinition[]): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: toolInputSchema(t) }));
}

/** The OpenAI-compatible `/tokenize` endpoint counts a flat `prompt` string and
 * takes no `tools:` field (§4.8, §11.7). To keep the exact count whole — the
 * real request binds these tool schemas and the §4.10 hard stop must not
 * undercount — serialize the tool schemas into the prompt so the SAME server
 * tokenizer counts them. This is counted text the server sees, not a ratio
 * estimate. */
function toolSchemaPromptText(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "";
  return tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: toolInputSchema(t) })).join("\n");
}

/** A single bounded, redirect-free fetch to the endpoint's OWN host. Returns the
 * parsed JSON body and status, or throws on a network error / timeout. */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COUNT_TOKENS_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      // §4.8 — follow NO redirects: a redirect to another host would carry the
      // endpoint's key off its own baseUrl. `redirect: "error"` rejects instead.
      redirect: "error",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** A capability that returns an exact input-token count or null (§4.8, §11.7).
 * `tools` are the tool definitions the request binds; they are counted too so the
 * exact count matches the assembled request (§4.8, §4.10).
 *
 * The capability DECLARES whether its count is `exact` (§4.8): Anthropic
 * `count_tokens` is exact, so its count is compared with the limit AS IS; the
 * OpenAI-compatible `/tokenize` flat-prompt count is NOT exact, so the pre-flight
 * `estimateMarginTokens` margin is kept on it. A plugin provider's count is not
 * declared exact and defaults to false. The `count` still returns `number |
 * null` either way — `exact` is a property of the capability, not the return. */
export type CountTokensFn = ((messages: BaseMessage[], tools: ToolDefinition[]) => Promise<number | null>) & {
  /** True when the endpoint's count is exact and needs no estimate margin (§4.8). */
  exact: boolean;
};

/** Tag a count function with its `exact` declaration (§4.8). */
function withExact(
  fn: (messages: BaseMessage[], tools: ToolDefinition[]) => Promise<number | null>,
  exact: boolean,
): CountTokensFn {
  return Object.assign(fn, { exact });
}

/**
 * Build the bundled `countTokens` capability for a resolved endpoint, or
 * `undefined` when the protocol offers none (§11.7). `apiKeyEnv` is read at call
 * time from the process environment and sent ONLY to the entry's own host.
 */
export function bundledCountTokens(entry: ModelConfigEntry): CountTokensFn | undefined {
  const protocol = entry.protocol;
  const key = entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined;

  if (protocol === "anthropic") {
    const url = anthropicCountUrl(entry.baseUrl);
    return withExact(async (messages, tools) => {
      const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
      if (key) headers["x-api-key"] = key;
      const res = await postJson(url, headers, {
        model: entry.model,
        messages: messages.map(toAnthropicMessage).filter((m) => m.content !== ""),
        // §4.8 — the request binds these tools, so count them too (no undercount).
        ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
      });
      // §4.8 — a 404/405/unsupported shape returns null so the caller marks the
      // endpoint unsupported for the session (never a throw masking a real error).
      if (res.status < 200 || res.status >= 300) return null;
      const n = (res.json as { input_tokens?: unknown } | null)?.input_tokens;
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    }, true); // Anthropic count_tokens is exact — no estimate margin (§4.8).
  }

  if (protocol === "openai") {
    const url = openAiTokenizeUrl(entry.baseUrl);
    if (!url) return undefined; // bundled cloud OpenAI offers no /tokenize
    return withExact(async (messages, tools) => {
      const headers: Record<string, string> = {};
      if (key) headers["authorization"] = `Bearer ${key}`;
      // §4.8 — /tokenize counts a flat prompt and has no tools field, so append
      // the bound tool schemas as counted text (not a ratio estimate) so the
      // server's own tokenizer includes them and the exact count is whole.
      const prompt = [messages.map(textOf).join("\n"), toolSchemaPromptText(tools)].filter(Boolean).join("\n");
      const res = await postJson(url, headers, { model: entry.model, prompt });
      if (res.status < 200 || res.status >= 300) return null;
      // vLLM/llama.cpp return `{ count }` or `{ tokens: [...] }`.
      const obj = res.json as { count?: unknown; tokens?: unknown } | null;
      if (obj && typeof obj.count === "number" && Number.isFinite(obj.count) && obj.count >= 0) return obj.count;
      if (obj && Array.isArray(obj.tokens)) return obj.tokens.length;
      return null;
    }, false); // the /tokenize flat prompt is not exact — keep the margin (§4.8).
  }

  // Google, Bedrock, and any other protocol: no bundled count capability (§11.7).
  return undefined;
}
