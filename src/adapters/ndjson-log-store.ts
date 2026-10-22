/**
 * The NDJSON observability log store (core-blueprint.md §10.3).
 *
 * Append-only NDJSON, one file per session, dual-layer: the workspace log
 * (`.voidrift/logs/{id}.log`) receives every record; the global log
 * (`~/.config/voidrift/logs/{id}.log`) receives only `status:error` records so a
 * cross-workspace failure sweep reads one place.
 *
 * Rotation is the `logrotate`/`journald` SIZE model (§10.3): a session log is a
 * set of segments bounded by a total of `logMaxSizeMB`. A write that would cross
 * the bound seals the active segment to `{path}.{epochMs}.old`, opens a fresh
 * one, and drops the OLDEST sealed segment first to stay within budget.
 * `logMaxAgeDays`, when set, additionally drops sealed segments past that age;
 * it is never the default and the active segment is never rotated by age.
 *
 * ## Rotation library choice
 * No dependency in the license-checked tree implements this exact model —
 * per-session NDJSON with a *total* size budget across sealed segments and an
 * explicit drop-oldest-first rule. `rotating-file-stream` (MIT) rotates a single
 * stream by size/time but keeps a count, not a byte budget across segments, and
 * owns its own write stream rather than appending through the host
 * `FileSystemPort` (§1 rule 1) that tests inject in-memory. A minimal
 * size-sealing implementation over the port is therefore used — ~40 lines,
 * deterministic, and testable with the in-memory filesystem — rather than
 * bending a stream library around the port seam.
 *
 * Writes and rotation are each wrapped so a filesystem failure is logged once
 * (an `ERROR_OCCURRED` through the bus) and swallowed, never a crash (§10.3).
 */
import type { FileSystemPort } from "../entities/ports/host.js";
import type { ObsLogStore } from "../entities/ports/obs-log-store.js";

export interface NdjsonLogStoreDeps {
  fs: FileSystemPort;
  /** `.voidrift/logs` relative to the workspace. */
  workspaceLogDir: string;
  /** The global log dir. When `globalFs` is set this is RELATIVE to `globalFs`'s
   * root (the global `~/.config/voidrift`); otherwise it is relative to `fs`. */
  globalLogDir: string;
  /** A filesystem port rooted at the global config dir (`~/.config/voidrift`),
   * used for the global error log so it is not rejected by the workspace-confined
   * workspace adapter (§10.3). Absent → `fs` is used for both (tests, in-memory). */
  globalFs?: FileSystemPort;
  getMaxSizeMB: () => number;
  getMaxAgeDays: () => number | undefined;
  onError?: (message: string) => void;
}

const DAY_MS = 86_400_000;

export class NdjsonLogStore implements ObsLogStore {
  /** Per-path append serialization. Writes are append-only (§10.3) and the
   * writer schedules them fire-and-forget, so without serialization concurrent
   * appends to one session file race on read-modify-write and lose records. Each
   * path's appends are chained so they apply in order. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: NdjsonLogStoreDeps) {}

  /** Run `op` after the prior append to `path` settles, serializing writes. */
  private serialize(path: string, op: () => Promise<void>): Promise<void> {
    const prior = this.chains.get(path) ?? Promise.resolve();
    const next = prior.then(op, op);
    // Keep the tail current; drop the entry when this is the last link so the
    // map does not grow without bound across sessions.
    this.chains.set(path, next);
    void next.finally(() => {
      if (this.chains.get(path) === next) this.chains.delete(path);
    });
    return next;
  }

  async appendWorkspace(sessionId: string, line: string): Promise<void> {
    const active = `${this.deps.workspaceLogDir}/${sessionId}.log`;
    await this.serialize(active, () => this.appendWithRotation(active, line));
  }

  async appendGlobal(sessionId: string, line: string): Promise<void> {
    const active = `${this.deps.globalLogDir}/${sessionId}.log`;
    const gfs = this.deps.globalFs ?? this.deps.fs;
    // The global error log is appended without rotation — it holds only the
    // error subset and is the cross-workspace sweep target (§10.3). It is written
    // through a dedicated global-rooted FS port so the absolute global path is
    // not rejected by the workspace-confined adapter. Serialized so concurrent
    // error records never lose an append.
    await this.serialize(active, async () => {
      try {
        const prior = (await gfs.exists(active)) ? await gfs.readFile(active) : "";
        await gfs.writeFile(active, prior + line + "\n");
      } catch (e) {
        this.deps.onError?.(`obs global log append failed: ${String(e)}`);
      }
    });
  }

  /** Await every accepted-but-unwritten append across all per-path queues
   * (§10.3). A clean shutdown calls this after the ObsWriter reaches quiescence
   * so a record queued in the store but not yet on disk cannot land after a
   * workspace teardown. The chains map holds each path's tail promise; an append
   * never schedules a further append from within the store, so draining the
   * current tails and re-checking until the map empties reaches a fixed point.
   * Bounded (64 passes) so a pathological producer cannot hang shutdown. */
  async drain(): Promise<void> {
    for (let i = 0; i < 64 && this.chains.size > 0; i += 1) {
      await Promise.allSettled([...this.chains.values()]);
    }
  }

  async readWorkspace(sessionId: string): Promise<string[]> {
    const active = `${this.deps.workspaceLogDir}/${sessionId}.log`;    const segments = await this.segmentsOf(active);
    // Oldest sealed first (ascending epoch) then the active segment, so a
    // chronological read is natural; newest-first is produced by reversing.
    const ordered = [...segments.sealed.sort((a, b) => a.epoch - b.epoch).map((s) => s.path), active];
    const lines: string[] = [];
    for (const path of ordered) {
      try {
        if (!(await this.deps.fs.exists(path))) continue;
        const body = await this.deps.fs.readFile(path);
        for (const l of body.split("\n")) if (l.trim() !== "") lines.push(l);
      } catch {
        /* a missing/corrupt segment is skipped */
      }
    }
    // Newest-first for the point-in-time query (§10.5).
    return lines.reverse();
  }

  // ── rotation ─────────────────────────────────────────────────────────────

  private async appendWithRotation(active: string, line: string): Promise<void> {
    try {
      const budget = Math.max(1, this.deps.getMaxSizeMB()) * 1024 * 1024;
      const addition = Buffer.byteLength(line + "\n", "utf8");
      const current = (await this.deps.fs.exists(active))
        ? Buffer.byteLength(await this.deps.fs.readFile(active), "utf8")
        : 0;

      if (current > 0 && current + addition > budget) {
        // Seal the active segment and open a fresh one.
        const sealed = `${active}.${Date.now()}.old`;
        const body = await this.deps.fs.readFile(active);
        await this.deps.fs.writeFile(sealed, body);
        await this.deps.fs.writeFile(active, "");
      }

      await this.rawAppend(active, line);
      await this.enforceBudget(active, budget);
      await this.enforceAge(active);
    } catch (e) {
      this.deps.onError?.(`obs log append failed: ${String(e)}`);
    }
  }

  /** Drop the oldest sealed segment(s) until the kept total is within budget. */
  private async enforceBudget(active: string, budget: number): Promise<void> {
    const { sealed } = await this.segmentsOf(active);
    const activeSize = (await this.deps.fs.exists(active))
      ? Buffer.byteLength(await this.deps.fs.readFile(active), "utf8")
      : 0;
    const ordered = sealed.sort((a, b) => a.epoch - b.epoch);
    let total = activeSize + ordered.reduce((n, s) => n + s.size, 0);
    for (const seg of ordered) {
      if (total <= budget) break;
      await this.deps.fs.remove(seg.path);
      total -= seg.size;
    }
  }

  /** Drop sealed segments past `logMaxAgeDays`; never the active segment (§10.3). */
  private async enforceAge(active: string): Promise<void> {
    const days = this.deps.getMaxAgeDays();
    if (days === undefined) return;
    const cutoff = Date.now() - days * DAY_MS;
    const { sealed } = await this.segmentsOf(active);
    for (const seg of sealed) {
      if (seg.epoch < cutoff) await this.deps.fs.remove(seg.path);
    }
  }

  /** Enumerate sealed segments `{path}.{epochMs}.old` for an active path. */
  private async segmentsOf(active: string): Promise<{ sealed: { path: string; epoch: number; size: number }[] }> {
    const sealed: { path: string; epoch: number; size: number }[] = [];
    try {
      const matches = await this.deps.fs.glob(`${active}.*.old`);
      for (const path of matches) {
        const m = /\.(\d+)\.old$/.exec(path);
        if (!m) continue;
        const size = (await this.deps.fs.exists(path))
          ? Buffer.byteLength(await this.deps.fs.readFile(path), "utf8")
          : 0;
        sealed.push({ path, epoch: Number(m[1]), size });
      }
    } catch {
      /* no sealed segments */
    }
    return { sealed };
  }

  private async rawAppend(path: string, line: string): Promise<void> {
    const prior = (await this.deps.fs.exists(path)) ? await this.deps.fs.readFile(path) : "";
    await this.deps.fs.writeFile(path, prior + line + "\n");
  }
}
