import fs from "fs";

/**
 * The host `@voidrift/core` version, for the plugin peer-range mismatch flag
 * (§12.4.1). Read once from this package's own `package.json`; a read failure
 * degrades to `0.0.0`, which only affects the display-only mismatch flag.
 */
let CORE_VERSION_CACHE: string | undefined;
export function coreVersion(): string {
  if (CORE_VERSION_CACHE !== undefined) return CORE_VERSION_CACHE;
  try {
    const url = new URL("../package.json", import.meta.url);
    const raw = fs.readFileSync(url, "utf8");
    CORE_VERSION_CACHE = (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    CORE_VERSION_CACHE = "0.0.0";
  }
  return CORE_VERSION_CACHE;
}
