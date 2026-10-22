/**
 * Inline reasoning splitter (core-blueprint.md §3.7, §4.7, §11).
 *
 * Local models (DeepSeek-R1, Qwen QwQ, many Ollama/vLLM builds) echo their
 * chain-of-thought INLINE in plain-string message content wrapped in a reasoning
 * tag — `<think>…</think>`, `<thinking>…</thinking>`, `<reasoning>…</reasoning>`
 * — rather than in a provider reasoning field (§4.7). If that inline reasoning
 * were persisted it would re-enter the context on every later request and
 * inflate the budget (invariant 24). This splitter strips it AT INGESTION so the
 * persisted chain and `TurnResult.text`/`TOKEN_STREAM` hold the visible text
 * only, routing the reasoning to `REASONING_STREAM` while streaming.
 *
 * Design:
 *   - A single stateful machine (`InlineReasoningSplitter`) fed chunk by chunk.
 *     Tags may be split across chunks (`'<thi'` + `'nk>'`), so a partial tag at a
 *     chunk boundary is held back in a BOUNDED pending buffer (never longer than
 *     the longest tag) until the next chunk resolves it or proves it literal.
 *   - Linear time: each input character is examined a constant number of times;
 *     the pending buffer is at most `MAX_TAG_LEN` characters, so memory is O(1).
 *   - Case-insensitive tag matching; repeated and adjacent blocks handled.
 *   - An unterminated block at end of stream keeps all text BEFORE the opener as
 *     visible and treats everything after as reasoning (never lost, never shown).
 *   - Nesting is treated as flat: once inside a block, text is reasoning until the
 *     first matching close tag — a nested `<think>` inside reasoning is itself
 *     reasoning. This never loses non-reasoning text, the one hard requirement.
 *   - A literal `<think>` inside a fenced code block is NOT specially exempted:
 *     a model that reasons inline does not emit fenced code around its own
 *     chain-of-thought, and exempting fences would require a full markdown parser
 *     and still mis-handle the real case. Documented tradeoff — the splitter
 *     favors never leaking reasoning over preserving a literal tag in prose. A
 *     consumer that must show a literal tag can escape it; the model's final text
 *     is what matters and it is preserved outside blocks.
 *
 * Pure entity: no LangChain, no infrastructure. The engine drives it over the
 * stream and at ingestion; this module owns the delimiter list and the state.
 */

/** The inline reasoning open/close delimiters (§4.7). Lowercased; matching is
 * case-insensitive. The one source of truth for the tag set. */
export const REASONING_TAGS = ["think", "thinking", "reasoning"] as const;

const OPENERS = REASONING_TAGS.map((t) => `<${t}>`);
const CLOSERS = REASONING_TAGS.map((t) => `</${t}>`);
/** The longest tag string length, the bound on the pending (held-back) buffer. */
const MAX_TAG_LEN = Math.max(...OPENERS.map((t) => t.length), ...CLOSERS.map((t) => t.length));

/** One split step's output: visible text and reasoning text for this feed. */
export interface SplitDelta {
  text: string;
  reasoning: string;
}

/** Could `buf` be a PREFIX of any opener (when outside a block) or closer
 * (inside a block)? Case-insensitive. Used to decide whether to hold a partial
 * `<…` back across a chunk boundary. */
function isTagPrefix(buf: string, inside: boolean): boolean {
  const lower = buf.toLowerCase();
  const candidates = inside ? [...CLOSERS, ...OPENERS] : OPENERS;
  return candidates.some((tag) => tag.startsWith(lower));
}

/** The stateful inline-reasoning splitter (§4.7). Fed chunk by chunk; `feed`
 * returns the visible/reasoning split for everything it can commit, holding only
 * a bounded partial tag back for the next chunk. `end()` flushes the tail. */
export class InlineReasoningSplitter {
  /** True while inside a reasoning block (between an opener and its closer). */
  private inside = false;
  /** A held-back partial that might begin a tag, carried to the next feed. */
  private pending = "";

  /** Feed one content chunk; returns the committed visible/reasoning split. */
  feed(chunk: string): SplitDelta {
    let text = "";
    let reasoning = "";
    let buf = this.pending + chunk;
    this.pending = "";
    let i = 0;
    while (i < buf.length) {
      const ch = buf[i]!;
      if (ch === "<") {
        // A '<' may begin a tag. Collect up to MAX_TAG_LEN chars and test.
        const slice = buf.slice(i, i + MAX_TAG_LEN);
        const lower = slice.toLowerCase();
        if (!this.inside) {
          const opener = OPENERS.find((t) => lower.startsWith(t));
          if (opener) {
            this.inside = true;
            i += opener.length;
            continue;
          }
        } else {
          const closer = CLOSERS.find((t) => lower.startsWith(t));
          if (closer) {
            this.inside = false;
            i += closer.length;
            continue;
          }
        }
        // Not a full tag here. If the REMAINDER of the buffer could still be the
        // prefix of a tag (a tag split across the chunk boundary), hold it back.
        const rest = buf.slice(i);
        if (rest.length < MAX_TAG_LEN && isTagPrefix(rest, this.inside)) {
          this.pending = rest;
          i = buf.length;
          break;
        }
        // A literal '<' that is not (the start of) a tag: emit it and advance.
        if (this.inside) reasoning += ch;
        else text += ch;
        i += 1;
        continue;
      }
      if (this.inside) reasoning += ch;
      else text += ch;
      i += 1;
    }
    void buf;
    return { text, reasoning };
  }

  /**
   * Flush at end of stream. Any held-back partial tag was never completed, so it
   * is literal: it becomes visible text when outside a block, reasoning when the
   * stream ended inside an unterminated block. An unterminated block loses no
   * text before its opener (that was already committed by `feed`).
   */
  end(): SplitDelta {
    const tail = this.pending;
    this.pending = "";
    if (tail === "") return { text: "", reasoning: "" };
    return this.inside ? { text: "", reasoning: tail } : { text: tail, reasoning: "" };
  }

  /** Whether the stream ended (or currently sits) inside a reasoning block. */
  get open(): boolean {
    return this.inside;
  }
}

/**
 * Split a COMPLETE string in one pass (§4.7) — the ingestion path for a
 * non-streamed assistant message whose content is a plain string. Returns the
 * visible text and the stripped reasoning. Equivalent to feeding the whole
 * string then `end()`.
 */
export function splitInlineReasoning(content: string): SplitDelta {
  const s = new InlineReasoningSplitter();
  const a = s.feed(content);
  const b = s.end();
  return { text: a.text + b.text, reasoning: a.reasoning + b.reasoning };
}

/** Whether a string contains any inline reasoning delimiter (cheap pre-check to
 * avoid rebuilding a message that has none). Case-insensitive. */
export function hasInlineReasoning(content: string): boolean {
  const lower = content.toLowerCase();
  return OPENERS.some((t) => lower.includes(t));
}
