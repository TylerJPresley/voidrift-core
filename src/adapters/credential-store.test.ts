/**
 * CredentialStore adapter tests (core-blueprint.md §8.4).
 *
 * The encrypted-file store round-trips a secret under AES-256-GCM at mode 0600;
 * the selector falls back to the encrypted file when a secret is supplied.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { EncryptedFileCredentialStore, selectCredentialStore } from "./credential-store.js";

describe("§8.4 — encrypted-file CredentialStore", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a secret and writes mode 0600", async () => {
    dir = hermeticTmp("cred");
    const file = path.join(dir, "creds.enc");
    const store = new EncryptedFileCredentialStore(file, "host-supplied-key");
    await store.set("mcp:acme:token", "s3cr3t-value");
    expect(await store.get("mcp:acme:token")).toBe("s3cr3t-value");
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    await store.delete("mcp:acme:token");
    expect(await store.get("mcp:acme:token")).toBeNull();
  });

  it("a wrong key cannot read a stored secret (ciphertext, not plaintext)", async () => {
    dir = hermeticTmp("cred2");
    const file = path.join(dir, "creds.enc");
    await new EncryptedFileCredentialStore(file, "key-a").set("k", "v");
    const wrong = new EncryptedFileCredentialStore(file, "key-b");
    // GCM auth failure → treated as absent, never the plaintext.
    expect(await wrong.get("k")).toBeNull();
  });

  it("the selector returns a store (keychain when available, else encrypted file)", async () => {
    dir = hermeticTmp("cred3");
    const store = await selectCredentialStore({ filePath: path.join(dir, "c.enc"), secret: "k" });
    expect(store).not.toBeNull();
  });
});
