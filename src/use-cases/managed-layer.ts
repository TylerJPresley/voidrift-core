/**
 * The managed layer resolver (core-blueprint.md §13.5).
 *
 * A deployment is managed when `managedSource` is configured. The managed layer
 * is read from a source the user process cannot write (an OS-protected path or
 * an integrity-verified source). This resolver reads that source through the
 * host FileSystemPort, validates it against the config schema, injects a valid
 * document as the config `managed` layer, and classifies the status.
 *
 * Fail-closed: while the status is `unavailable` or `invalid`, `gate()` returns a
 * reason so the decision point denies every gated action with
 * `managed_layer_unavailable` (§9.6). The status is reported through
 * `MANAGED_LAYER_STATUS` at boot (when configured) and on every change,
 * including recovery to `ok` (§2.1, §14.6).
 */
import { ConfigSchema } from "../config/schema.js";
import type { FileSystemPort } from "../entities/ports/host.js";

export type ManagedStatusKind = "none" | "ok" | "unavailable" | "invalid";

export interface ManagedStatus {
  status: ManagedStatusKind;
  reason?: string;
  source?: string;
}

export interface ManagedLayerDeps {
  /** The managed source (path) when configured; absent → unmanaged (§13.5). */
  source?: string;
  fs: FileSystemPort;
  /** Install a validated managed document as the config `managed` layer, then
   * re-resolve the cascade. Called only with a valid document. */
  installManagedDoc: (doc: Record<string, unknown> | null) => Promise<void>;
  /** Emit MANAGED_LAYER_STATUS (global scope, §14.6). */
  emitStatus: (payload: ManagedStatus) => void;
}

export class ManagedLayer {
  private current: ManagedStatus;
  /** The managed-only auto-approve-mode control (§13.5, §13.9): honored ONLY from the
   * managed layer and ignored anywhere else. Default `true` (the host-only mode
   * is available); `false` makes a host asked to start in `auto_approve`
   * refuse to construct. Captured from the raw managed JSON and stripped before
   * schema validation so the strict `ConfigSchema` never carries the key — it
   * is not representable in global, project, or session config. */
  private autoApproveAllowed_ = true;

  constructor(private readonly deps: ManagedLayerDeps) {
    this.current = deps.source ? { status: "unavailable", source: deps.source } : { status: "none" };
  }

  /** The current managed-layer status. */
  status(): ManagedStatus {
    return { ...this.current };
  }

  /** Whether the managed layer permits the host-only `auto_approve` mode
   * (§13.5). `true` when unmanaged or when the managed layer omits the key or
   * sets it true; `false` only when a loaded managed layer sets it false. */
  autoApproveAllowed(): boolean {
    return this.autoApproveAllowed_;
  }

  /** True (as a reason) when gated actions must be denied — the managed layer is
   * configured but not currently `ok` (§13.5 fail-closed). Returns `null` when
   * gated actions are enabled (unmanaged, or managed-and-ok). */
  gate(): { reason: string } | null {
    if (this.current.status === "none" || this.current.status === "ok") return null;
    return { reason: this.current.reason ?? `managed layer ${this.current.status}` };
  }

  /**
   * Read and classify the managed source, installing a valid document. Emits
   * MANAGED_LAYER_STATUS when the status changes (and always at the first call
   * when a managed layer is configured). Returns the resulting status.
   */
  async resolve(): Promise<ManagedStatus> {
    const source = this.deps.source;
    if (!source) {
      return this.transition({ status: "none" }, false);
    }

    let raw: string;
    try {
      raw = await this.deps.fs.readFile(source);
    } catch (e) {
      return this.transition(
        { status: "unavailable", source, reason: `managed source unreadable: ${msg(e)}` },
        true,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return this.transition(
        { status: "invalid", source, reason: `managed source is not valid JSON: ${msg(e)}` },
        true,
      );
    }

    // §13.5 — `autoApproveAllowed` is honored ONLY here. Capture it from the raw
    // managed object and STRIP it before schema validation and installation, so
    // the strict `ConfigSchema` never carries the key (it stays non-representable
    // in every other layer, where it is a validation error). A non-boolean or
    // absent value leaves the default `true`.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if ("autoApproveAllowed" in rec) {
        this.autoApproveAllowed_ = rec["autoApproveAllowed"] === false ? false : true;
        delete rec["autoApproveAllowed"];
      }
    }

    const result = ConfigSchema.partial().safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      const where = first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "schema error";
      return this.transition(
        { status: "invalid", source, reason: `managed layer invalid — ${where}` },
        true,
      );
    }

    await this.deps.installManagedDoc(parsed as Record<string, unknown>);
    return this.transition({ status: "ok", source }, true);
  }

  /** Record a status and emit MANAGED_LAYER_STATUS when it changes (or always
   * when a managed layer is configured and this is the boot emission). */
  private transition(next: ManagedStatus, configured: boolean): ManagedStatus {
    const changed = next.status !== this.current.status || next.reason !== this.current.reason;
    const prevWasInitial = this.emittedCount === 0;
    this.current = next;
    if (configured && (changed || prevWasInitial)) {
      this.emittedCount++;
      this.deps.emitStatus({ ...next });
    }
    return { ...next };
  }

  private emittedCount = 0;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
