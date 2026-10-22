/**
 * The credential store port (core-blueprint.md §8.4).
 *
 * A consumer-implementable seam for MCP OAuth tokens and HTTP auth secrets. Two
 * adapters ship: an OS-keychain adapter (`@napi-rs/keyring`) and an
 * encrypted-file adapter (AES-256-GCM, mode 0600, key from
 * `VOIDRIFT_CREDENTIAL_KEY`). Selection prefers the keychain and falls back to
 * the encrypted file. Secrets held here are never written to config, a log, or
 * an approval payload (§10.10).
 */
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
