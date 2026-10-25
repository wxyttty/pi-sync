/**
 * Archive entry validation rules for pi-sync backups.
 *
 * Shared between the sync extension and tests. Defines:
 *   - which core config files are packed/restored
 *   - which agent-root files are reserved (never enter/leave an archive)
 *   - the conservative shape of a valid archive entry list
 *
 * Import: import { validateArchiveEntries, CORE_CONFIG_FILES, … } from "../_shared/archive-rules"
 */

/** Core agent-dir config files packed under the "Config" toggle. */
export const CORE_CONFIG_FILES = ["models.json", "settings.json", "auth.json", "mcp.json"];

/** Never packed or restored: sync credentials must not enter the archive. */
export const RESERVED_CONFIG_FILES = new Set(["sync_config.json"]);

/** Conservative portable filename for config/<name>.json archive entries. */
export const SAFE_CONFIG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/**
 * Validate normalized archive entries before extraction.
 *
 * Layout contract:
 *   manifest.json                  (optional, exactly at root)
 *   config/<name>.json             (flat; safe portable names; no reserved files)
 *   skills/…  extensions/…          (directories)
 *
 * Rejects absolute paths, `..`, drive letters, nested config paths,
 * reserved config files (sync credentials), and case-colliding config names.
 */
export function validateArchiveEntries(entries: string[]): void {
  const allowedTopLevel = new Set(["config", "skills", "extensions", "manifest.json"]);

  // Ignore empty / root-only noise left after normalizing "./"
  const meaningful = entries.filter((e) => e && e !== "." && e !== "./");

  if (meaningful.length === 0) {
    throw new Error("Backup archive is empty or unreadable");
  }

  // lowercased name → original name, to reject case-colliding destinations
  const configNames = new Map<string, string>();

  for (const entry of meaningful) {
    const pathParts = entry.split("/").filter(Boolean);
    if (entry.startsWith("/") || /^[a-zA-Z]:\//.test(entry) || pathParts.includes("..")) {
      throw new Error(`Unsafe archive path rejected: ${entry}`);
    }

    const [topLevel, secondPart] = pathParts;
    if (!topLevel || !allowedTopLevel.has(topLevel)) {
      throw new Error(`Unexpected top-level archive entry rejected: ${entry}`);
    }

    if (topLevel === "manifest.json") {
      if (pathParts.length > 1) {
        throw new Error(`Unexpected archive entry rejected: ${entry}`);
      }
      continue;
    }

    if (topLevel === "config") {
      // Bare "config" is the directory entry itself (tar lists dirs) — fine.
      if (pathParts.length === 1) continue;
      // Exactly config/<name>.json — no nested paths.
      if (pathParts.length !== 2 || !secondPart) {
        throw new Error(`Unexpected config archive entry rejected: ${entry} (expected config/<file>.json)`);
      }
      if (!SAFE_CONFIG_NAME_RE.test(secondPart)) {
        throw new Error(`Unexpected config file rejected: ${entry}`);
      }
      const lower = secondPart.toLowerCase();
      if (RESERVED_CONFIG_FILES.has(lower)) {
        throw new Error(`Reserved config file rejected: ${entry} (never restored)`);
      }
      const prev = configNames.get(lower);
      if (prev && prev !== secondPart) {
        throw new Error(`Case-colliding config files rejected: ${prev} vs ${secondPart}`);
      }
      configNames.set(lower, secondPart);
    }
  }
}
