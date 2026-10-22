/**
 * Rollback integrity binding (core-blueprint.md §10.12, §9.4) — the per-install
 * secret and the HMAC that binds every `timeline.json` / `moves/<id>.json` to
 * THIS install, THIS session id, and THIS workspace realpath.
 *
 * Why (HIGH security): `.voidrift/cache/snapshots/<session>/{timeline.json,
 * moves/*.json,blobs/*}` can ship inside a cloned, untrusted repo. Without a
 * binding, `voidrift --resume <id>` then `/undo` would replay an attacker's
 * planted manifest + blobs and write attacker-chosen content to any non-
 * protected workspace path. The session store is ALSO in-repo, so binding to it
 * is not enough. Two independent layers defend this:
 *   (a) CONTENT RE-HASH — the stores re-hash every blob on read: a blob whose
 *       bytes do not hash to the requested sha is treated as missing/corrupt
 *       (the path reports `restorable:false, reason:'snapshot content failed its
 *       integrity check'`). This lives in the stores (getBlob / cat-file).
 *   (b) HMAC BINDING — this module. A random 32-byte key is created lazily,
 *       atomically, mode 0600, in the GLOBAL config dir (`rollback.key`), never
 *       printed/exported, hidden from listings, and in the protected-paths DENY
 *       class + the doctor storage-mode check. Every timeline/manifest carries
 *       an `hmac` over the canonical JSON of the rest + the session id + the
 *       workspace realpath. A missing/invalid HMAC (planted, copied from another
 *       machine, or edited) is IGNORED as untrusted and nothing is restored.
 *
 * If the key cannot be created/read (read-only global dir), this degrades to a
 * PER-PROCESS in-memory key: history works inside the process but is not trusted
 * across restarts (a resume starts empty, since the in-memory key differs from
 * any prior one). The degrade is reported through `keyState()` for the doctor.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, realpathSync } from "node:fs";
import path from "node:path";

/** The per-install key file name under the global config dir. */
export const ROLLBACK_KEY_FILE = "rollback.key";
const KEY_BYTES = 32;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** How the integrity key was resolved, for the doctor (§10.12). */
export type KeyState = "persisted" | "in-memory";

/**
 * Resolves and caches the per-install integrity key. ONE instance per store;
 * boot wires the global config dir in. A null `globalConfigDir` (a pure
 * in-memory test, or a host that cannot resolve one) forces the in-memory key.
 */
export class RollbackIntegrity {
  private key: Buffer | null = null;
  private state: KeyState = "in-memory";
  /** A process-lifetime random key used when the file cannot be persisted. */
  private static inMemoryKey: Buffer | null = null;

  constructor(private readonly globalConfigDir: string | null) {}

  /** The resolved key state, for the doctor ROLLBACK group. Resolves the key if
   * not yet done so the report reflects reality. */
  keyState(): KeyState {
    this.resolveKey();
    return this.state;
  }

  /** The absolute path of the key file, or null when no global dir is known. */
  keyPath(): string | null {
    return this.globalConfigDir ? path.join(this.globalConfigDir, ROLLBACK_KEY_FILE) : null;
  }

  /** Resolve (lazily) the integrity key. Reads the existing `rollback.key`, or
   * creates one atomically (temp+rename, 0600). On any failure degrades to a
   * per-process in-memory key (history not trusted across restarts). */
  private resolveKey(): Buffer {
    if (this.key) return this.key;
    const kp = this.keyPath();
    if (kp) {
      try {
        if (existsSync(kp)) {
          const buf = readFileSync(kp);
          if (buf.length >= KEY_BYTES) {
            try {
              chmodSync(kp, FILE_MODE);
            } catch {
              /* best-effort tightening */
            }
            this.key = buf;
            this.state = "persisted";
            return this.key;
          }
          // A short/corrupt key file: fall through to recreate it.
        }
        mkdirSync(path.dirname(kp), { recursive: true, mode: DIR_MODE });
        const fresh = randomBytes(KEY_BYTES);
        const tmp = `${kp}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, fresh, { mode: FILE_MODE });
        renameSync(tmp, kp);
        try {
          chmodSync(kp, FILE_MODE);
        } catch {
          /* best-effort */
        }
        this.key = fresh;
        this.state = "persisted";
        return this.key;
      } catch {
        // Read-only global dir (or any I/O failure): degrade to in-memory.
      }
    }
    // Degrade: a per-process key. Resume across a restart starts empty because
    // the key differs each process — history is trusted only within the process.
    if (!RollbackIntegrity.inMemoryKey) RollbackIntegrity.inMemoryKey = randomBytes(KEY_BYTES);
    this.key = RollbackIntegrity.inMemoryKey;
    this.state = "in-memory";
    return this.key;
  }

  /** The workspace realpath binding component. A path that cannot be realpathed
   * (not yet created) falls back to the raw absolute path. */
  private static boundWorkspace(workspaceRoot: string): string {
    try {
      return realpathSync(workspaceRoot);
    } catch {
      return path.resolve(workspaceRoot);
    }
  }

  /** Compute the HMAC-SHA256 over the canonical JSON of `payload` + the session
   * id + the workspace realpath, hex-encoded. */
  sign(payload: unknown, sessionId: string, workspaceRoot: string): string {
    const key = this.resolveKey();
    const msg = `${canonicalJson(payload)}\n${sessionId}\n${RollbackIntegrity.boundWorkspace(workspaceRoot)}`;
    return createHmac("sha256", key).update(msg, "utf8").digest("hex");
  }

  /** Verify a stored HMAC against the payload/session/workspace binding. A
   * missing, malformed, or mismatched HMAC returns false (treat as untrusted). */
  verify(payload: unknown, sessionId: string, workspaceRoot: string, hmac: unknown): boolean {
    if (typeof hmac !== "string" || !/^[0-9a-f]{64}$/.test(hmac)) return false;
    const expected = this.sign(payload, sessionId, workspaceRoot);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(hmac, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/**
 * Deterministic canonical JSON: object keys sorted recursively so the signed
 * bytes do not depend on key insertion order. Arrays keep order. Used only for
 * the HMAC input (not for persistence, which stays `JSON.stringify`).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
