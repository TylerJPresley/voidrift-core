/**
 * Protected control-path classification (core-blueprint.md §8.4, §9.4, §13.5) —
 * the ONE source of truth for "is this path a VoidRift control file, and how
 * protected is it?". Both the file tools (`write_file`/`edit_file`) and the
 * shell gate (`execute_command`, write-shaped segments) classify a target
 * through `classifyControlPath` so a control file cannot be changed by picking a
 * different tool or spelling.
 *
 * Two classes:
 *   - `deny` — maintained ONLY through the gated capability APIs (`config.set`,
 *     `mcp.approve`, `plugins.enable`/`install`); never writable through the
 *     file tools OR the shell, in ANY layer (project OR the global config dir),
 *     and the mutation journal (a RAW local store, §10.11). These are the
 *     project and global `config.json`/`managed.json`/`mcp-pins.json`, the
 *     plugin stores, and the journal.
 *   - `ask`  — always-ask: a write is a FORCE-ASK (`forceAskKind: 'control-file'`),
 *     never auto-approved, liftable only by an EXACT allow rule. These are the
 *     agent and skill directories (project and global), the git hooks dir and
 *     `.git/config`, `.github/workflows/`, `~/.ssh/authorized_keys`/`config`,
 *     and any `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`SKILL.md` anywhere in the
 *     workspace.
 *
 * STATIC normalization only (accepted limitation): `~`, `$HOME`, `${HOME}`, and
 * `$XDG_CONFIG_HOME` are resolved from the `ctx` values; a relative path is
 * resolved against the workspace root; `.`/`..` segments are collapsed;
 * backslashes fold to `/`; comparison of the protected tails is
 * case-insensitive. A form that cannot be resolved statically (a shell variable
 * other than those, a substitution, an unresolved `${XDG_CONFIG_HOME:-~/.config}`
 * when `XDG_CONFIG_HOME` is unset) returns `null` — the caller then applies its
 * ordinary classification. This is pattern classification over the path text,
 * not an OS check: it never touches the filesystem.
 */

/** The classification of a control path. `null` = not a control path (or not
 * statically resolvable). */
export type ControlPathClass = "deny" | "ask" | null;

/** The context a classification needs — all absolute, caller-supplied (never
 * `process.cwd()`/`process.env` read here): the workspace root a relative path
 * resolves against, the global config dir (`voidriftConfigDir()`), and the home
 * directory for `~`/`$HOME` expansion. */
export interface ControlPathContext {
  workspaceRoot?: string;
  globalConfigDir?: string;
  home?: string;
}

/** The control files denied inside EITHER the project `.voidrift/` or the
 * global config dir (the tail after that directory). */
const DENY_CONFIG_FILES = ["config.json", "managed.json", "mcp-pins.json"];

/**
 * The core-owned `.voidrift/cache/<name>/` subtrees that are NOT control state:
 * the session result cache, the symbol index cache, and the worker staging dir.
 * Every OTHER `cache/<name>/` subtree is owner-only harness state — the rollback
 * snapshot store (`snapshots`) and a plugin cache namespace returned by
 * `WorkspaceSurface.cacheDir` (e.g. `retrieval`) — written ONLY by the core or
 * the owning plugin, never a file tool or the shell (§9.4, §10.12, retrieval §4,
 * core §12.4). Classifying by an explicit allowlist keeps a new plugin cache
 * protected by default without touching the core's own writable caches.
 */
const WRITABLE_CACHE_SUBTREES = new Set(["session", "index", "staging"]);

/**
 * True when a `.voidrift`-relative (or global-config-dir-relative) tail names a
 * PROTECTED cache location. Protected:
 *   - any `cache/<name>/<rest>` with a non-empty subtree, for a `<name>` NOT in
 *     {@link WRITABLE_CACHE_SUBTREES} — the owner-only store a plugin creates via
 *     `WorkspaceSurface.cacheDir` (files live inside the namespace dir), and the
 *     rollback snapshot blobs under `cache/snapshots/...`; and
 *   - the bare directory `cache/snapshots` or `cache/retrieval` (preserved: a
 *     write TO the directory node itself is refused too).
 * A bare file directly under `cache/` (e.g. `cache/x.json`) is NOT a namespace
 * dir and stays unprotected, as do the writable core subtrees.
 */
function isProtectedCacheTail(tail: string): boolean {
  const t = tail.toLowerCase().replace(/\/+$/, "");
  if (!t.startsWith("cache/")) return false;
  const rest = t.slice("cache/".length);
  if (rest === "") return false;
  const slash = rest.indexOf("/");
  if (slash < 0) {
    // A bare `cache/<x>` node — protect only the known control directories.
    return rest === "snapshots" || rest === "retrieval";
  }
  const name = rest.slice(0, slash);
  if (name === "") return false;
  return !WRITABLE_CACHE_SUBTREES.has(name);
}

/** The per-install rollback integrity key, denied inside the GLOBAL config dir
 * only (§10.12, §9.4): never writable by file tools or the shell, never printed,
 * hidden from listings. It carries the HMAC secret that binds rollback history
 * to this install. */
const DENY_GLOBAL_FILES = ["rollback.key"];

/** The basenames (case-insensitive) that are always-ask anywhere in the
 * workspace (steering/agent docs the model must not silently rewrite). */
const ASK_BASENAMES = new Set(["agents.md", "claude.md", "gemini.md", "skill.md"]);

/** Fold a raw path to a canonical, forward-slash, `.`/`..`-collapsed absolute-or-
 * relative string WITHOUT resolving home/env (those are resolved first by the
 * caller). A trailing slash is stripped; the leading slash (absolute) is kept. */
function collapse(path: string): string {
  const abs = path.startsWith("/");
  const segs: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return (abs ? "/" : "") + segs.join("/");
}

/** Resolve the statically-resolvable home/env prefixes in a raw path using the
 * ctx values, or `null` when a prefix needs a value the ctx does not carry (so
 * the caller falls back to its ordinary classification). Returns the resolved
 * (still un-collapsed) forward-slash path. */
function resolvePrefixes(raw: string, ctx: ControlPathContext): string | null {
  let p = raw.replace(/\\/g, "/").trim();
  if (p === "") return null;

  // `$XDG_CONFIG_HOME` → the parent of the global config dir (globalConfigDir is
  // `<XDG or ~/.config>/voidrift`, so its parent is `$XDG_CONFIG_HOME`). We only
  // ever compare against the global config dir itself, so expanding to its
  // parent + `/voidrift` is unnecessary; expand `$XDG_CONFIG_HOME` to that
  // parent directly. When unset AND the home is unknown we cannot resolve → null.
  const xdgMatch = /^\$\{?XDG_CONFIG_HOME\}?/.exec(p);
  if (xdgMatch) {
    const configDir = ctx.globalConfigDir?.replace(/\\/g, "/").replace(/\/+$/, "");
    // The global config dir is `<xdgOrConfig>/voidrift`; its parent is the XDG
    // config home. Expand `$XDG_CONFIG_HOME` to that parent.
    if (!configDir) return null;
    const parent = configDir.slice(0, configDir.lastIndexOf("/"));
    p = parent + p.slice(xdgMatch[0].length);
    return p;
  }

  // `~`, `$HOME`, `${HOME}` → the home dir.
  const homeMatch = /^(~|\$\{?HOME\}?)(\/|$)/.exec(p);
  if (homeMatch) {
    const home = ctx.home?.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!home) return null;
        p = home + p.slice(homeMatch[1]!.length);
    return p;
  }

  // Any OTHER unresolved shell variable / substitution in the path → we cannot
  // classify statically; defer to the ordinary classification (accepted
  // limitation). A `$` that is a literal filename char is rare; fail safe to
  // null only when it looks like a variable reference.
  if (/\$\{?[A-Za-z_]/.test(p)) return null;

  return p;
}

/** The tail of `abs` under `prefix` (prefix is a dir), or `null` when `abs` is
 * not inside `prefix`. Both are collapsed, forward-slash, case preserved; the
 * comparison of the prefix is case-insensitive. */
function tailUnder(abs: string, prefix: string | undefined): string | null {
  if (!prefix) return null;
  const pfx = collapse(prefix.replace(/\\/g, "/"));
  if (pfx === "") return null;
  const a = abs.toLowerCase();
  const p = pfx.toLowerCase();
  if (a === p) return "";
  if (a.startsWith(p + "/")) return abs.slice(pfx.length + 1);
  return null;
}

/**
 * Classify a raw path as a protected control file (§8.4, §9.4). Returns `deny`,
 * `ask`, or `null` (not a control path, or not statically resolvable). Pure.
 */
export function classifyControlPath(rawPath: string, ctx: ControlPathContext): ControlPathClass {
  if (!rawPath) return null;
  const resolved = resolvePrefixes(rawPath, ctx);
  if (resolved === null) return null;

  const root = ctx.workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  // Make an absolute-or-workspace-relative canonical path. A relative path is
  // resolved against the workspace root (when known); an absolute path stays.
  let canonical: string;
  if (resolved.startsWith("/")) {
    canonical = collapse(resolved);
  } else if (root) {
    canonical = collapse(root + "/" + resolved);
  } else {
    // No workspace root to anchor a relative path: collapse as-is and match the
    // relative control-file tails below via the project-relative checks.
    canonical = collapse(resolved);
  }
  const lower = canonical.toLowerCase();
  const base = canonical.slice(canonical.lastIndexOf("/") + 1).toLowerCase();

  // ── DENY class ────────────────────────────────────────────────────────────
  // Project `.voidrift/{config,managed,mcp-pins}.json` and plugin store/journal.
  const projectVoidrift = root ? `${root}/.voidrift` : ".voidrift";
  const projTail = tailUnder(canonical, projectVoidrift);
  const projTailResolved =
    projTail ?? tailUnderRelative(canonical, ".voidrift", root);
  if (projTailResolved !== null) {
    if (DENY_CONFIG_FILES.includes(projTailResolved.toLowerCase())) return "deny";
    if (projTailResolved.toLowerCase().startsWith("plugins/") || projTailResolved.toLowerCase() === "plugins")
      return "deny";
    if (projTailResolved.toLowerCase().startsWith("journal/") || projTailResolved.toLowerCase() === "journal")
      return "deny";
    // The rollback snapshot cache `.voidrift/cache/snapshots/` holds RAW file
    // contents, so it is a protected control location exactly like the journal
    // (§9.4, §10.12). A plugin cache namespace `.voidrift/cache/<ns>/` (returned
    // by `WorkspaceSurface.cacheDir`, retrieval §4, core §12.4) is likewise an
    // owner-only store changed ONLY through the owning plugin, never a file tool
    // or the shell. Both are protected; the core-owned NON-raw cache subtrees
    // (`session`, `index`, `staging`) stay writable (they are not control state).
    if (isProtectedCacheTail(projTailResolved)) return "deny";
    // agents/ and skills/ under the project .voidrift are ASK (handled below).
  }

  // Global config dir `{config,managed,mcp-pins}.json`, plugins, journal.
  const globalTail = tailUnder(canonical, ctx.globalConfigDir);
  if (globalTail !== null) {
    if (DENY_CONFIG_FILES.includes(globalTail.toLowerCase())) return "deny";
    if (DENY_GLOBAL_FILES.includes(globalTail.toLowerCase())) return "deny";
    if (globalTail.toLowerCase().startsWith("plugins/") || globalTail.toLowerCase() === "plugins") return "deny";
    if (globalTail.toLowerCase().startsWith("journal/") || globalTail.toLowerCase() === "journal") return "deny";
    // The durable registry directory `<global config dir>/registry/` (§12.5) is
    // changed ONLY through plugin commands and the `registry` CoreAPI, never by
    // a file tool or the shell — a DENY-class control location like the plugin
    // store and the journal.
    if (globalTail.toLowerCase().startsWith("registry/") || globalTail.toLowerCase() === "registry") return "deny";
    if (isProtectedCacheTail(globalTail)) return "deny";
  }

  // Global plugin store / journal by TAIL, independent of `ctx.globalConfigDir`
  // (owner S1, preserving the old `PROTECTED_CONTROL_DIRS` substring behaviour):
  // any path whose normalized form contains `voidrift/plugins/` or
  // `voidrift/journal/` (the project `.voidrift` or the global
  // `<config>/voidrift`) is a RAW/trusted store the file and shell tools must
  // never touch, even when the real global config dir differs from the path.
  const slashed = lower + "/";
  for (const dir of ["voidrift/plugins/", "voidrift/journal/", "voidrift/cache/snapshots/", "voidrift/cache/retrieval/", "voidrift/registry/"]) {
    if (slashed.includes("." + dir) || slashed.includes("/" + dir) || slashed.startsWith(dir)) return "deny";
  }

  // ── ASK class ─────────────────────────────────────────────────────────────
  // Project `.voidrift/agents/**`, `.voidrift/skills/**`.
  if (projTailResolved !== null) {
    const t = projTailResolved.toLowerCase();
    if (t === "agents" || t.startsWith("agents/")) return "ask";
    if (t === "skills" || t.startsWith("skills/")) return "ask";
  }
  // Global config dir `agents/**`, `skills/**`.
  if (globalTail !== null) {
    const t = globalTail.toLowerCase();
    if (t === "agents" || t.startsWith("agents/")) return "ask";
    if (t === "skills" || t.startsWith("skills/")) return "ask";
  }
  // Project `.git/hooks/**`, `.git/config`, `.github/workflows/**`.
  const gitTail = tailUnder(canonical, root ? `${root}/.git` : ".git") ?? tailUnderRelative(canonical, ".git", root);
  if (gitTail !== null) {
    const t = gitTail.toLowerCase();
    if (t === "hooks" || t.startsWith("hooks/")) return "ask";
    if (t === "config") return "ask";
  }
  const ghTail =
    tailUnder(canonical, root ? `${root}/.github` : ".github") ?? tailUnderRelative(canonical, ".github", root);
  if (ghTail !== null) {
    const t = ghTail.toLowerCase();
    if (t === "workflows" || t.startsWith("workflows/")) return "ask";
  }
  // `~/.ssh/authorized_keys` and `~/.ssh/config` (write-shaped only; the caller
  // decides when to consult this, but classifying here keeps one source).
  if (ctx.home) {
    const sshTail = tailUnder(canonical, `${ctx.home.replace(/\\/g, "/").replace(/\/+$/, "")}/.ssh`);
    if (sshTail !== null) {
      const t = sshTail.toLowerCase();
      if (t === "authorized_keys" || t === "config") return "ask";
    }
  }
  // Any AGENTS.md/CLAUDE.md/GEMINI.md/SKILL.md anywhere (case-insensitive).
  if (ASK_BASENAMES.has(base)) {
    // Only within the workspace when a root is known; otherwise match anywhere.
    if (!root || lower === collapse(root).toLowerCase() + "/" + base || lower.startsWith(collapse(root).toLowerCase() + "/")) {
      return "ask";
    }
    if (!root) return "ask";
  }

  return null;
}

/** When no workspace root is known, match a project-relative control dir tail
 * (`.voidrift/…`, `.git/…`, `.github/…`) that appears at the START of a
 * collapsed RELATIVE path. Returns the tail after `dir/`, or `null`. */
function tailUnderRelative(canonical: string, dir: string, root: string | undefined): string | null {
  if (root) return null; // an absolute root already anchored it above
  const lower = canonical.toLowerCase();
  const d = dir.toLowerCase();
  if (lower === d) return "";
  if (lower.startsWith(d + "/")) return canonical.slice(dir.length + 1);
  return null;
}

/**
 * S5 (LOW hardening): re-classify a `write_file`/`edit_file` target through
 * `classifyControlPath` AFTER resolving symlinks, so an in-workspace symlink
 * pointing at a protected file (`notes.md -> .voidrift/config.json`, perhaps
 * committed in a hostile repo) cannot let a write slip through on the RAW model
 * path (which classifies as a harmless `notes.md`). The file tools classify the
 * raw path first (fast, pure); this is the second gate on the RESOLVED path.
 *
 * Resolution mirrors the FileSystemPort containment chokepoint: realpath the
 * DEEPEST EXISTING ANCESTOR, then re-attach the not-yet-existing tail. If the
 * FINAL component is itself a symlink to a protected path, its realpath is the
 * protected target and this returns that classification. `realpath` is injected
 * (the decision point passes `fs.realpathSync.native`); it throws on a missing
 * path, so we walk up until it resolves. Pure except for the injected realpath.
 *
 * Returns the STRICTER-OR-EQUAL of the raw and resolved classifications so the
 * caller can apply a single denial. A relative path is resolved against
 * `ctx.workspaceRoot`; without a workspace root (pure tests) it returns the raw
 * classification unchanged.
 */
export function classifyResolvedControlPath(
  rawPath: string,
  ctx: ControlPathContext,
  realpath: (p: string) => string,
): ControlPathClass {
  const rawCls = classifyControlPath(rawPath, ctx);
  const root = ctx.workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || !rawPath) return rawCls;

  // Resolve the raw path to an absolute (collapsed) path first; an absolute raw
  // path stays, a relative one anchors at the workspace root.
  const resolved = resolvePrefixes(rawPath, ctx);
  if (resolved === null) return rawCls;
  const abs = resolved.startsWith("/") ? collapse(resolved) : collapse(root + "/" + resolved);

  // Walk up to the deepest existing ancestor that `realpath` can resolve, then
  // re-attach the remaining tail — the SAME strategy as the FileSystemPort.
  let probe = abs;
  const tailParts: string[] = [];
  for (;;) {
    try {
      const real = realpath(probe).replace(/\\/g, "/");
      const realTarget = tailParts.length === 0 ? real : real + "/" + tailParts.join("/");
      const resolvedCls = classifyControlPath(realTarget, ctx);
      return stricter(rawCls, resolvedCls);
    } catch {
      const idx = probe.lastIndexOf("/");
      if (idx <= 0) return rawCls; // reached root with no resolvable ancestor
      tailParts.unshift(probe.slice(idx + 1));
      probe = probe.slice(0, idx);
    }
  }
}

/** The stricter of two classes: `deny` > `ask` > `null`. */
function stricter(a: ControlPathClass, b: ControlPathClass): ControlPathClass {
  if (a === "deny" || b === "deny") return "deny";
  if (a === "ask" || b === "ask") return "ask";
  return null;
}

/**
 * READ classification (core-blueprint.md §9.4, §10.11, §10.12) — the ONE source
 * of truth for "may the model's `read_file` read this path?". The WRITE
 * classification above protects control files from being CHANGED; this protects
 * a small set from being READ:
 *
 *   - **Read-denied control stores** (the spec says "neither read nor write"):
 *     the per-session mutation journal (`.voidrift/journal/**`, §10.11), the
 *     rollback snapshot cache (`.voidrift/cache/snapshots/**`, §10.12), and the
 *     per-install rollback integrity key (`<global config dir>/rollback.key`,
 *     §10.12). `checkpoint.db` lives under the session store dir, not inside the
 *     workspace, so it is unreachable by a workspace-relative read; the journal
 *     and snapshots ARE in-workspace, so they are denied here.
 *   - **Cross-session run cache** (MED): the run cache
 *     `.voidrift/cache/run/<session>/` holds pass-by-reference blobs that are
 *     deliberately READABLE by `read_file` so a handle round-trips — but ONLY
 *     for the CURRENT session's own subtree. A read of ANOTHER session's subtree
 *     is denied (one session must not read another's blobs).
 *
 * Returns `"deny"` to refuse the read, or `null` to allow it (the ordinary read
 * proceeds). `currentSessionId` scopes the run-cache allowance. Pure; static over
 * the path text, same normalization limits as {@link classifyControlPath}.
 */
export function classifyReadPath(
  rawPath: string,
  ctx: ControlPathContext,
  currentSessionId: string | undefined,
): "deny" | null {
  if (!rawPath) return null;
  const resolved = resolvePrefixes(rawPath, ctx);
  if (resolved === null) return null;
  const root = ctx.workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  let canonical: string;
  if (resolved.startsWith("/")) canonical = collapse(resolved);
  else if (root) canonical = collapse(root + "/" + resolved);
  else canonical = collapse(resolved);
  const lower = canonical.toLowerCase();

  // Global `rollback.key` — read-denied (the HMAC secret, §10.12).
  const globalTail = tailUnder(canonical, ctx.globalConfigDir);
  if (globalTail !== null && DENY_GLOBAL_FILES.includes(globalTail.toLowerCase())) return "deny";

  // Resolve the `.voidrift`-relative tail (project root or a bare relative path).
  const projectVoidrift = root ? `${root}/.voidrift` : ".voidrift";
  const tail = tailUnder(canonical, projectVoidrift) ?? tailUnderRelative(canonical, ".voidrift", root);

  // Journal and snapshots: read-denied regardless of session (§9.4/§10.11/§10.12).
  const slashed = lower + "/";
  for (const dir of ["voidrift/journal/", "voidrift/cache/snapshots/"]) {
    if (slashed.includes("." + dir) || slashed.includes("/" + dir) || slashed.startsWith(dir)) return "deny";
  }
  if (tail !== null) {
    const t = tail.toLowerCase();
    if (t === "journal" || t.startsWith("journal/")) return "deny";
    if (t === "cache/snapshots" || t.startsWith("cache/snapshots/")) return "deny";

    // Run cache: allow ONLY the current session's subtree; deny every other.
    if (t === "cache/run" || t.startsWith("cache/run/")) {
      const rest = t === "cache/run" ? "" : t.slice("cache/run/".length);
      if (rest === "") return "deny"; // listing the run root itself is not a blob read
      const sid = rest.split("/")[0]!;
      const cur = (currentSessionId ?? "").toLowerCase();
      if (cur === "" || sid !== cur) return "deny";
      return null; // the current session's own blob — allowed
    }
  }
  return null;
}
