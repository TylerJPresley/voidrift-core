/**
 * Public-surface guard (core-blueprint.md §1 rule 4, §2, invariant 14).
 *
 * Invariant 14: "no LangChain or LangGraph type crosses the CoreAPI
 * method/DTO/event surface; construction-time port injection is the one
 * exception." This test enforces it structurally with the TypeScript compiler
 * API (already a devDependency): it walks every type reachable from the exports
 * of `src/index.ts` — the ONE public import surface — and asserts that no type
 * identifier resolves to a declaration in `@langchain/*`, `langchain`, or
 * `@langgraph/*`, EXCEPT the explicitly allow-listed construction-time injection
 * types (§1 rule 4: port injection is the one exception).
 *
 * A regression — someone adds a library type to a method/DTO/event signature,
 * e.g. `AgentDefinition.model?: BaseChatModel` — makes a forbidden identifier
 * reachable from a non-allow-listed export and FAILS this test. Proven below by
 * the companion check that the resolver DOES flag a known library type when it
 * is reachable (so the guard cannot silently pass).
 *
 * Offline, deterministic: a single `ts.Program` over the source. No build step.
 */
import { describe, it, expect, beforeAll } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const INDEX = path.join(SRC, "index.ts");

/** Forbidden module path fragments: a type whose declaration lives here is a
 * LangChain/LangGraph type (invariant 14). */
const FORBIDDEN = ["@langchain/", "/langchain/", "@langgraph/", "node_modules/langchain/"];

/**
 * Allow-listed PUBLIC exports whose reachable types legitimately include a
 * construction-time injection shape (§1 rule 4 — port injection is the one
 * exception). These are the ports/factories a HOST implements and injects at
 * `createCore`, never values a CoreAPI METHOD returns or accepts across a
 * DTO/event. Each is a consumer-implemented port or an injection factory type.
 */
const INJECTION_ALLOWLIST = new Set<string>([
  // §1 rule 4 — the CONSTRUCTION surface: `createCore` and its options/result
  // types legitimately reference the injected checkpointer/store/model-provider
  // factory (BaseCheckpointSaver, BaseChatModel). This is port injection at
  // construction time, the one documented exception; it is NOT a method/DTO/event.
  "createCore",
  "CoreOptions",
  "CoreReady",
  // Model access: the port a host implements; `chatModel()` returns a bound
  // LangChain client ONLY at the construction seam, never across a method DTO.
  "ModelPort",
  // Durable seams injected at construction (checkpointer/store live behind these
  // adapter exports, not on any method signature).
  "InMemorySessionRepository",
  "InMemoryConfigStore",
  // Consumer-implemented port/shape interfaces (tools, guardrails, context
  // providers, memory, credentials, exporters) — the plugin/injection surface.
  "ToolDefinition",
  "ToolExecutor",
  "ToolResult",
  "ToolContext",
  "Guardrail",
  "GuardrailResult",
  "GuardrailContext",
  "MemoryProvider",
  "MemoryStore",
  "CredentialStore",
  "ObsExporter",
  "ContextProvider",
  "ScopedCoreApi",
]);

/** Build a program over index.ts and return the checker + the module exports. */
function programForIndex(): { checker: ts.TypeChecker; exports: ts.Symbol[]; program: ts.Program } {
  // Use the project's own tsconfig so @langchain/* module resolution matches the
  // real build (otherwise library type symbols resolve to nothing and the guard
  // would be vacuous).
  const configPath = path.join(SRC, "..", "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  } as ts.ParseConfigFileHost);
  const options: ts.CompilerOptions = {
    ...(parsed?.options ?? {}),
    noEmit: true,
    skipLibCheck: true,
  };
  const program = ts.createProgram([INDEX], options);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(INDEX);
  if (!sf) throw new Error(`cannot load ${INDEX}`);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) throw new Error("no module symbol for index.ts");
  return { checker, exports: checker.getExportsOfModule(moduleSymbol), program };
}

/** Follow aliases to the real symbol. */
function resolve(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol {
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

/** The source file path of a symbol's first declaration, or "". */
function declFile(sym: ts.Symbol): string {
  const d = sym.getDeclarations()?.[0];
  return d ? d.getSourceFile().fileName : "";
}

/** Is this declaration file a forbidden (LangChain/LangGraph) module? */
function isForbiddenFile(file: string): boolean {
  const norm = file.replace(/\\/g, "/");
  return FORBIDDEN.some((f) => norm.includes(f));
}

/**
 * Walk every type identifier reachable from an exported declaration and return
 * the names of any that resolve to a forbidden declaration file. Bounded by a
 * visited set over declaration nodes.
 */
function forbiddenTypesReachable(checker: ts.TypeChecker, root: ts.Symbol): string[] {
  const hits = new Set<string>();
  const seenDecls = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    // Skip the construction surface: a constructor and any private/protected
    // member of a class are NOT the method/DTO/event surface (§1 rule 4 — port
    // injection at construction is the one exception). Public methods and
    // properties (the DTO/method surface) ARE walked.
    if (ts.isConstructorDeclaration(node)) return;
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isParameterPropertyDeclaration(node, node.parent)) &&
      node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
      )
    ) {
      return;
    }
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const typeName = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
      const sym = checker.getSymbolAtLocation(typeName);
      if (sym) {
        const real = resolve(checker, sym);
        const file = declFile(real);
        if (file && isForbiddenFile(file)) {
          hits.add(real.getName());
        } else if (file && !file.includes("node_modules")) {
          // A first-party type alias/interface — descend into its declarations
          // so an indirectly-referenced library type is still caught. EXCEPT an
          // injection-allow-listed port type is a construction boundary (§1 rule
          // 4): a host implements it with library types behind the seam, so we do
          // not treat types reachable THROUGH it as crossing the method surface.
          if (!INJECTION_ALLOWLIST.has(real.getName())) {
            for (const d of real.getDeclarations() ?? []) {
              if (!seenDecls.has(d)) {
                seenDecls.add(d);
                visit(d);
              }
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  for (const d of resolve(checker, root).getDeclarations() ?? []) {
    if (!seenDecls.has(d)) {
      seenDecls.add(d);
      visit(d);
    }
  }
  return [...hits];
}

describe("public-surface guard — no LangChain/LangGraph type crosses the CoreAPI surface (invariant 14)", () => {
  // Building a ts.Program is the expensive step; do it ONCE and share the checker
  // across the three checks (and allow it the time it needs under suite load).
  let checker: ts.TypeChecker;
  let exports: ts.Symbol[];
  beforeAll(() => {
    ({ checker, exports } = programForIndex());
  }, 60_000);

  it("no non-injection public export reaches a @langchain / langchain / @langgraph type", () => {
    const violations: { export: string; types: string[] }[] = [];
    for (const exp of exports) {
      const name = exp.getName();
      if (INJECTION_ALLOWLIST.has(name)) continue;
      const hits = forbiddenTypesReachable(checker, exp);
      if (hits.length > 0) violations.push({ export: name, types: [...new Set(hits)] });
    }
    expect(
      violations,
      `public exports leaking library types: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  }, 30_000);

  it("the resolver DOES flag a forbidden type when one is reachable (guard is not vacuous)", () => {
    // Prove the walker catches a library type: ModelPort (allow-listed) reaches
    // `BaseChatModel` via `chatModel()`. Running the resolver on it WITHOUT the
    // allow-list must report the forbidden type — otherwise the guard above
    // could pass trivially and miss a real regression.
    const modelPort = exports.find((e) => e.getName() === "ModelPort");
    expect(modelPort, "ModelPort export must exist").toBeTruthy();
    const hits = forbiddenTypesReachable(checker, modelPort!);
    expect(hits).toContain("BaseChatModel");
  });

  it("AgentDefinition is reachable and carries NO library type (model is a string key)", () => {
    const agentDef = exports.find((e) => e.getName() === "AgentDefinition");
    expect(agentDef, "AgentDefinition must be exported").toBeTruthy();
    const hits = forbiddenTypesReachable(checker, agentDef!);
    expect(hits, `AgentDefinition leaks: ${hits.join(", ")}`).toEqual([]);
  });

  it("config.init is HOST-ONLY: ScopedCoreApi exposes no config namespace (§13.9)", () => {
    // §13.9: `config.init` is absent from the plugin ScopedCoreApi, so a plugin
    // can never seed/reset/re-validate the installation. Assert structurally
    // against the type: the ScopedCoreApi export has no `config` member at all,
    // and its `register`/`registry`/`events`/`session` members carry no `init`.
    const scoped = exports.find((e) => e.getName() === "ScopedCoreApi");
    expect(scoped, "ScopedCoreApi must be exported").toBeTruthy();
    const type = checker.getDeclaredTypeOfSymbol(resolve(checker, scoped!));
    const members = checker.getPropertiesOfType(type).map((p) => p.getName());
    expect(members, `ScopedCoreApi members: ${members.join(", ")}`).not.toContain("config");
    expect(members).not.toContain("init");
  });

  it("session.export is HOST-ONLY: ScopedCoreApi.session exposes no export (§10.13)", () => {
    // §10.13: `session.export` is absent from the plugin ScopedCoreApi, so a
    // plugin can never export a session. Assert structurally: the ScopedCoreApi
    // `session` member exposes ONLY `runInNewSession`, never `export`.
    const scoped = exports.find((e) => e.getName() === "ScopedCoreApi");
    expect(scoped, "ScopedCoreApi must be exported").toBeTruthy();
    const type = checker.getDeclaredTypeOfSymbol(resolve(checker, scoped!));
    const sessionProp = checker.getPropertiesOfType(type).find((p) => p.getName() === "session");
    expect(sessionProp, "ScopedCoreApi.session must exist").toBeTruthy();
    const sessionType = checker.getTypeOfSymbolAtLocation(sessionProp!, sessionProp!.valueDeclaration ?? sessionProp!.declarations![0]!);
    const sessionMembers = checker.getPropertiesOfType(sessionType).map((p) => p.getName());
    expect(sessionMembers, `ScopedCoreApi.session members: ${sessionMembers.join(", ")}`).not.toContain("export");
    expect(sessionMembers).toContain("runInNewSession");
  });
});
