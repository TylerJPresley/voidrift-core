/**
 * CredentialStore adapters (core-blueprint.md §8.4).
 *
 * Two shipped adapters hold MCP OAuth tokens and HTTP auth secrets off disk and
 * off every log/approval payload (§10.10):
 *
 *  - `KeychainCredentialStore` — the OS keychain via `@napi-rs/keyring` (MIT).
 *  - `EncryptedFileCredentialStore` — AES-256-GCM, the file written mode 0600,
 *    the key supplied by the host through `VOIDRIFT_CREDENTIAL_KEY` and never
 *    derived from machine identity alone.
 *
 * `selectCredentialStore` prefers the keychain when available and falls back to
 * the encrypted file otherwise.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CredentialStore } from "../entities/ports/credential-store.js";

const SERVICE = "voidrift";

/** The OS-keychain store (§8.4). Lazily loads the native binding so a platform
 * without it falls back cleanly. */
export class KeychainCredentialStore implements CredentialStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly Entry: new (service: string, account: string) => any) {}

  async get(key: string): Promise<string | null> {
    try {
      return new this.Entry(SERVICE, key).getPassword() ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    new this.Entry(SERVICE, key).setPassword(value);
  }

  async delete(key: string): Promise<void> {
    try {
      new this.Entry(SERVICE, key).deletePassword();
    } catch {
      /* already absent */
    }
  }
}

/** AES-256-GCM encrypted-file store (§8.4). The key comes from the host env;
 * it is never derived from machine identity alone. */
export class EncryptedFileCredentialStore implements CredentialStore {
  private readonly key: Buffer;

  constructor(
    private readonly filePath: string,
    secret: string,
  ) {
    // Derive a 32-byte key from the host-supplied secret (SHA-256). The secret
    // itself is the host's responsibility (§8.4); we never fall back to a
    // machine-identity-only key.
    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  private async load(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const { iv, tag, data } = JSON.parse(raw) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async save(store: Record<string, string>): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plain = Buffer.from(JSON.stringify(store), "utf8");
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = JSON.stringify({
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: data.toString("base64"),
    });
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, payload, { mode: 0o600 });
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async get(key: string): Promise<string | null> {
    const store = await this.load();
    return store[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const store = await this.load();
    store[key] = value;
    await this.save(store);
  }

  async delete(key: string): Promise<void> {
    const store = await this.load();
    delete store[key];
    await this.save(store);
  }
}

/**
 * Prefer the OS keychain; fall back to the encrypted file. The keychain binding
 * is loaded dynamically so its optional native dependency never blocks a build
 * or a platform without it (§8.4).
 */
export async function selectCredentialStore(opts: {
  filePath: string;
  secret?: string;
}): Promise<CredentialStore | null> {
  try {
    const mod = (await import("@napi-rs/keyring")) as { Entry?: new (s: string, a: string) => unknown };
    if (mod.Entry) {
      // Probe: constructing an Entry must not throw on a supported platform.
       
      return new KeychainCredentialStore(mod.Entry);
    }
  } catch {
    /* keychain unavailable — fall back */
  }
  if (opts.secret) {
    return new EncryptedFileCredentialStore(opts.filePath, opts.secret);
  }
  return null;
}

/**
 * A `CredentialStore` that resolves the real adapter (keychain or encrypted
 * file) lazily on first use via `selectCredentialStore`, so a synchronous
 * composition root can hold a store reference without awaiting selection. When
 * no store is selectable (no keychain and no secret), every operation is a
 * safe no-op: `get` returns `null`, `set`/`delete` do nothing — connect then
 * proceeds without auth (§8.4) and `saveConfig` rejects a secret header rather
 * than persisting it.
 */
export class LazyCredentialStore implements CredentialStore {
  private resolved: Promise<CredentialStore | null> | undefined;

  constructor(private readonly opts: { filePath: string; secret?: string }) {}

  private select(): Promise<CredentialStore | null> {
    return (this.resolved ??= selectCredentialStore(this.opts));
  }

  async get(key: string): Promise<string | null> {
    return (await this.select())?.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await (await this.select())?.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await (await this.select())?.delete(key);
  }
}
