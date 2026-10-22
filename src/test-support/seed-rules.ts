/**
 * Test helper: the seeded allow rules (§13.8, §9.2).
 *
 * Read-class is NOT a permission input (§9): the harness no longer makes reads
 * free by a shortcut — the SEEDED allow list is what makes the read built-ins
 * (`read_file`, `glob_files`, `search_contents`, `workspace_map`, …) run without
 * a prompt. Tests that used to rely on reads being free now install these rules
 * explicitly, exactly as `config.init` seeds them, instead of re-adding a
 * shortcut. Shared so no test re-declares the seeded rules (DRY, §15.1#4).
 *
 * Same-package import only (`config/seed.js`); no cross-package import.
 */
import { seedPermissions } from "../config/seed.js";
import type { PermissionRule } from "../config/schema.js";

/** The seeded allow rules as a flat array (the shape Guardian/the decision point
 * evaluate): every seeded `read_file`/`glob_files`/… rule plus the seeded safe
 * `execute_command` patterns. */
export function seededAllowRules(): PermissionRule[] {
  return Object.values(seedPermissions());
}

/** The seeded allow rules as the `permissions` RECORD a config carries (keyed by
 * the stable seed id), for injecting into an in-memory config/ConfigSchema. */
export function seededPermissionsRecord(): Record<string, PermissionRule> {
  return seedPermissions();
}
