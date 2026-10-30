/**
 * Project-context assembly (core-blueprint.md §6.6, §4.2.1 tier 2).
 *
 * `AGENTS.md` is loaded as `project` memory and rendered into the head as a
 * DIGEST plus a POINTER to its full copy in the session cache, so its rules
 * influence every turn without the whole file occupying the head. Discovery
 * walks from the workspace root; a nested file nearer a referenced path takes
 * priority over one higher up, and a workspace file overrides a global one.
 * Multiple files merge most-specific-last so the narrower instruction wins.
 *
 * The file is untrusted input (§1 rule 15, §6.6): read as content, never
 * executed. The whole merge is kept (never silently cut, §4.8/§8.7); when it
 * exceeds the head budget the head carries an INGEST DIGEST (or, until one is
 * cached, a marked head) plus a pointer to the full copy and the marker line
 * naming `limits.ingest.fitFraction` (and `limits.memory.projectChars` as the
 * explicit override). These are pure functions — the FS walk lives in the
 * discovery adapter and the ingest fan-out in the use-case.
 */
import { contentHash } from "../hash.js";
import { limitDefault } from "../limits.js";

/** The marker line the head carries when the project instructions are larger
 * than the head budget (§4.8/§8.7). Names the registry key to raise. */
export const PROJECT_OVERFLOW_MARKER =
  "Project instructions are larger than the head budget (limits.ingest.fitFraction, or set limits.memory.projectChars to override); this is a digest - read the full file with read_file for exact wording";

/** The §4.8 token estimate (4 chars/token) shared with Ingest and the chunkers,
 * used to convert the fraction-of-window budget into a char budget. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
export function tokensToChars(tokens: number): number {
  return tokens * 4;
}

/** A discovered project-instructions file, with its depth from the root. */
export interface ProjectFile {
  path: string;
  content: string;
  /** Path-segment depth from the workspace root; deeper = more specific (§6.6). */
  depth: number;
  scope: "workspace" | "global";
}

/** The merged project context: the full text, the head, and the budget. */
export interface ProjectContext {
  /** The WHOLE merged content, written to the session cache (tier 2 pointer).
   * Never cut — the model can always read the full file (§4.8/§8.7). */
  full: string;
  /** The text that rides the head (§4.2.1 tier 2): the whole content when it
   * fits the head budget, else the ingest DIGEST (or a marked head until one is
   * cached) plus the overflow marker. */
  digest: string;
  /** True when the merged content exceeds the head budget (so `digest` is a
   * reduced head, not the whole content). Kept named `truncated` for back-compat
   * with existing callers; the FULL text is never actually cut. */
  truncated: boolean;
  /** The char budget applied to the head. */
  limit: number;
  /** True when the content exceeds the head budget (alias of `truncated`). */
  overflow: boolean;
  /** SHA-256 of the full merged content — the ingest/digest cache key input. */
  hash: string;
}

/**
 * Order files most-specific-LAST (§6.6): global before workspace, then shallower
 * before deeper, so a deeper workspace file is appended last and its rules win on
 * a merge-most-specific-last read. Stable within equal (depth, scope).
 */
export function orderProjectFiles(files: ProjectFile[]): ProjectFile[] {
  const scopeRank = (s: ProjectFile["scope"]): number => (s === "global" ? 0 : 1);
  return files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => scopeRank(a.f.scope) - scopeRank(b.f.scope) || a.f.depth - b.f.depth || a.i - b.i)
    .map(({ f }) => f);
}

/** Derive a short digest from merged content: the first non-empty lines up to
 * `maxChars` (§4.2.1 tier 2). The pointer carries the full copy. The default
 * cap is the `memory.projectDigestMaxChars` registry limit. */
export function deriveDigest(full: string, maxChars = limitDefault("memory.projectDigestMaxChars")): string {
  const lines = full.split("\n").filter((l) => l.trim() !== "");
  let digest = "";
  for (const line of lines) {
    if (digest.length + line.length + 1 > maxChars) break;
    digest += (digest === "" ? "" : "\n") + line;
  }
  if (digest === "") digest = full.slice(0, maxChars);
  return digest;
}

/** Cap a snippet at `max`, adding an ellipsis when cut. */
function cap(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** The end index (exclusive) of the Nth sentence in `text`, or the end of the
 * string when there are fewer than `n` sentence boundaries. A boundary is a
 * sentence-ending `.`, `!` or `?` followed by whitespace or the end of the text.
 * AGENTS.md is hard-wrapped, so the paragraph's lines are already joined with
 * spaces before this runs; a wrap that split mid-sentence is thus healed. */
function sentenceEnd(text: string, n: number): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = text[i + 1];
    if (next === undefined || next === " " || next === "\t") {
      count++;
      if (count === n) return i + 1;
    }
  }
  return text.length;
}

/** The first sentence of a paragraph, UNCAPPED. The paragraph's wrapped lines
 * are joined with spaces first so a sentence split across a hard wrap is
 * rejoined (the OLD first-LINE behaviour returned a fragment such as
 * "…Start the"). The caller caps it to the section's derived share. */
function firstSentence(paragraph: string): string {
  const joined = paragraph
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" ")
    .trim();
  return joined.slice(0, sentenceEnd(joined, 1)).trim();
}

/**
 * Derive the GENERIC STRUCTURAL head digest for project instructions (§4.2.1
 * tier 2): the lead paragraph before the first heading (treated as an ordinary
 * first section — reduced to its first sentence), then every Markdown heading in
 * DOCUMENT ORDER, each followed by the FIRST SENTENCE of its section's first
 * paragraph — or, for a list-item section, its first item. Because real
 * `AGENTS.md` files are hard-wrapped, a section's wrapped lines are joined with
 * spaces before the sentence is cut, so the snippet is a whole sentence, not a
 * fragment ("…Start the"). This is a REAL digest — a deterministic, no-model,
 * project-neutral reduction that relocates (never drops) the body: the full copy
 * always rides the session-cache pointer. No wording is hard-coded, so the
 * digest works for any `AGENTS.md`, not just this project's.
 *
 * The per-section sentence allowance is DERIVED from the single budget
 * `maxChars` (default `memory.projectDigestMaxChars`), not a separate constant:
 * each section (the pre-heading text counts as one) gets an equal share,
 * `share = floor(maxChars / sectionCount)`, and its sentence is cut to
 * `share − heading length − separators` (ellipsis when cut). Fewer sections →
 * larger share → longer sentences; more sections → tighter sentences. Unspent
 * share from a short sentence is not redistributed (kept simple). When the full
 * digest fits, entries are emitted in DOCUMENT ORDER (lead, then each heading +
 * first-sentence). Over budget (very many sections), a priority fill keeps the
 * MAP intact first: all headings (in order), then the first-sentences (in
 * order), then the lead paragraph fills whatever remains.
 */
export function projectDigest(full: string, maxChars = limitDefault("memory.projectDigestMaxChars")): string {
  const rawLines = full.split("\n");
  const isHeading = (s: string): boolean => /^#{1,6}\s+\S/.test(s);

  // The lead paragraph: the first run of non-empty lines BEFORE the first
  // heading, treated as an ordinary first section — its FIRST sentence joined
  // across hard wraps (uncapped here; the per-section share caps it below).
  // Hard-wrapped Markdown makes the first LINE a fragment, so the paragraph is
  // joined and cut at a sentence boundary instead.
  const lead: string[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (isHeading(trimmed)) break;
    if (trimmed === "") {
      if (lead.length > 0) break;
      continue;
    }
    lead.push(trimmed);
  }
  const leadRaw = lead.length === 0 ? "" : firstSentence(lead.join("\n"));

  // Each heading in document order, paired with the FIRST SENTENCE of its
  // section's first paragraph (or, when the section opens with a list, the first
  // list item), joined across hard wraps (uncapped; capped by the share below).
  interface Section {
    heading: string;
    /** The uncapped joined first sentence / first list item of the section. */
    firstRaw: string;
  }
  const isListItem = (s: string): boolean => /^(?:[-*+]\s+|\d+[.)]\s+)/.test(s);
  const stripMarker = (s: string): string => s.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "");
  const sections: Section[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = (rawLines[i] ?? "").trim();
    if (!isHeading(trimmed)) continue;
    // Find the first non-empty, non-heading line after the heading.
    let start = -1;
    for (let j = i + 1; j < rawLines.length; j++) {
      const t = (rawLines[j] ?? "").trim();
      if (isHeading(t)) break;
      if (t !== "") {
        start = j;
        break;
      }
    }
    let firstRaw = "";
    if (start !== -1) {
      const startLine = (rawLines[start] ?? "").trim();
      if (isListItem(startLine)) {
        // A list-item section: the first item, including its wrapped
        // continuation lines (indented or plain, until the next item or blank).
        const parts = [stripMarker(startLine)];
        for (let j = start + 1; j < rawLines.length; j++) {
          const raw = rawLines[j] ?? "";
          const t = raw.trim();
          if (t === "" || isHeading(t) || isListItem(t)) break;
          parts.push(t);
        }
        firstRaw = parts.join(" ").trim();
      } else {
        // A prose section: the first paragraph (lines until a blank, heading or
        // list), reduced to its first sentence.
        const parts: string[] = [];
        for (let j = start; j < rawLines.length; j++) {
          const raw = rawLines[j] ?? "";
          const t = raw.trim();
          if (t === "" || isHeading(t) || isListItem(t)) break;
          parts.push(t);
        }
        firstRaw = firstSentence(parts.join("\n"));
      }
    }
    sections.push({ heading: trimmed, firstRaw });
  }

  // Derive the per-section sentence allowance from the ONE budget. Every section
  // (the pre-heading lead counts as one when present) gets an equal share of the
  // budget; its sentence is cut to the share less the heading and the entry's
  // separators. SEP is the two structural separators an entry spends: the "\n"
  // between a heading and its sentence and the "\n\n" that joins entries — a
  // formatting literal, not a tunable content bound.
  const sectionCount = sections.length + (leadRaw !== "" ? 1 : 0);
  const SEP = 2;
  const share = sectionCount === 0 ? maxChars : Math.floor(maxChars / sectionCount);
  const leadParagraph = leadRaw === "" ? "" : cap(leadRaw, Math.max(0, share - SEP));
  const capped = sections.map((s) => {
    if (s.firstRaw === "") return { heading: s.heading, first: "" };
    const budget = share - s.heading.length - SEP;
    return { heading: s.heading, first: budget > 0 ? cap(s.firstRaw, budget) : "" };
  });

  // No structure at all (no headings, no lead): fall back to leading lines.
  if (sections.length === 0 && leadParagraph === "") {
    return deriveDigest(full, maxChars);
  }

  // Entries in DOCUMENT ORDER: the lead paragraph, then each heading with its
  // first line beneath it.
  const inOrder: string[] = [];
  if (leadParagraph !== "") inOrder.push(leadParagraph);
  for (const s of capped) inOrder.push(s.first !== "" ? `${s.heading}\n${s.first}` : s.heading);

  const whole = inOrder.join("\n\n");
  if (whole.length <= maxChars) return whole;

  // Over budget: keep the MAP first. Fill headings (in order), then
  // first-sentences (in order), then the lead. Entries render in document order
  // regardless of fill priority, so the head always reads top-to-bottom.
  const chosenHeading = new Array<boolean>(capped.length).fill(false);
  const chosenFirst = new Array<boolean>(capped.length).fill(false);
  let chosenLead = false;

  const render = (): string => {
    const parts: string[] = [];
    if (chosenLead) parts.push(leadParagraph);
    for (let i = 0; i < capped.length; i++) {
      const s = capped[i];
      if (!s || !chosenHeading[i]) continue;
      parts.push(chosenFirst[i] && s.first !== "" ? `${s.heading}\n${s.first}` : s.heading);
    }
    return parts.join("\n\n");
  };

  // Priority 1: headings, in order.
  for (let i = 0; i < capped.length; i++) {
    chosenHeading[i] = true;
    if (render().length > maxChars) {
      chosenHeading[i] = false;
      break;
    }
  }
  // Priority 2: first-sentences, in order (only for headings already chosen).
  for (let i = 0; i < capped.length; i++) {
    const s = capped[i];
    if (!s || !chosenHeading[i] || s.first === "") continue;
    chosenFirst[i] = true;
    if (render().length > maxChars) chosenFirst[i] = false;
  }
  // Priority 3: the lead paragraph fills whatever remains.
  if (leadParagraph !== "") {
    chosenLead = true;
    if (render().length > maxChars) chosenLead = false;
  }

  const digest = render();
  return digest.trim() !== "" ? digest : deriveDigest(full, maxChars);
}

/**
 * Merge discovered files most-specific-last (§6.6), keeping the WHOLE content —
 * never cut (§4.8/§8.7). Each file is separated by a header naming its path
 * (provenance; data, never authority). The budget decision (whole vs digest) is
 * made by `assembleProjectHead`, so the full text here is always complete.
 */
export function mergeFull(files: ProjectFile[]): string {
  const ordered = orderProjectFiles(files);
  return ordered.map((f) => `# ${f.path}\n${f.content}`).join("\n\n");
}

/**
 * Assemble the project context against the head budget (§4.8/§8.7). The full
 * merged text is always kept whole (the session-cache pointer carries it). The
 * HEAD always carries a REAL digest — a deterministic structural reduction
 * (headings + the key rule lines + a short lead paragraph, `projectDigest`) —
 * never the full body, so project instructions cost a bounded, small head every
 * turn while the exact wording is one `read_file` away (§4.2.1 tier 2). When the
 * content exceeds the budget it is additionally flagged `overflow` and the head
 * carries `cachedDigest` (the §8.7 ingest digest, when one exists) or a marked
 * head up to the budget, each with the overflow marker naming
 * `limits.ingest.fitFraction`.
 *
 * `truncated` is true whenever the head is a reduced digest (so the caller's
 * label reads "digest — full file via read_file"); `overflow` is true only when
 * the content exceeded the budget (so the caller fires the LIMIT_HIT). The two
 * are now distinct: a file that fits the budget still rides as a digest, with no
 * overflow warning.
 *
 * `cachedDigest` is null on the FIRST overflow turn (no ingest digest cached
 * yet): the head then carries the marked head (content up to the budget) and the
 * caller kicks the ingest in the background so the next turn hits the cache. The
 * head is NEVER blocked on a worker fan-out.
 */
export function assembleProjectHead(
  files: ProjectFile[],
  budgetChars: number,
  cachedDigest: string | null = null,
  digestMaxChars: number = limitDefault("memory.projectDigestMaxChars"),
): ProjectContext {
  const full = mergeFull(files);
  const hash = contentHash(full);
  if (full.length <= budgetChars) {
    // Fits the budget, but the head still carries a REAL structural digest, not
    // the whole body — the full copy rides the session-cache pointer (§4.2.1).
    // `digestMaxChars` is the effective `memory.projectDigestMaxChars` the caller
    // threads from the limits port (live override); the registry default keeps
    // the entity pure when called directly.
    const digest = projectDigest(full, digestMaxChars);
    return { full, digest, truncated: true, limit: budgetChars, overflow: false, hash };
  }
  let head: string;
  if (cachedDigest && cachedDigest.trim() !== "") {
    head = `${PROJECT_OVERFLOW_MARKER}\n\n${cachedDigest}`;
  } else {
    // First turn (no digest yet): carry the head of the content up to the budget
    // WITH the marker and pointer. The ingest is kicked in the background.
    const room = Math.max(0, budgetChars - PROJECT_OVERFLOW_MARKER.length - 2);
    head = `${PROJECT_OVERFLOW_MARKER}\n\n${full.slice(0, room)}`;
  }
  return { full, digest: head, truncated: true, limit: budgetChars, overflow: true, hash };
}

/**
 * Back-compat merge that stops at a byte bound (used by legacy call sites and
 * the §6.6 ordering tests). It merges most-specific-last and, when the content
 * exceeds `limit`, keeps the whole text but flags `overflow`/`truncated`. It
 * never cuts `full` (§4.8/§8.7); the head reduction is `assembleProjectHead`.
 */
export function mergeProjectContext(files: ProjectFile[], limit: number): ProjectContext {
  return assembleProjectHead(files, limit, null);
}
