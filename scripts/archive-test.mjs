#!/usr/bin/env node
/**
 * Tests for backup archive validation rules (extensions/_shared/archive-rules.ts).
 * Loads the REAL TypeScript module via jiti.
 */
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

async function loadModule() {
  const require = createRequire(import.meta.url);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const jitiCandidates = [
    join(home, ".pi/agent/install/releases", process.env.PI_RELEASE || "1.4.0", "node_modules/jiti/lib/jiti.cjs"),
    join(home, ".pi/agent/npm/node_modules/jiti/lib/jiti.cjs"),
    join(home, ".pi/agent/npm/node_modules/jiti/lib/index.js"),
  ];
  for (const jp of jitiCandidates) {
    try {
      const { createJiti } = require(jp);
      const jiti = createJiti(import.meta.url);
      return await jiti.import(join(root, "extensions/_shared/archive-rules.ts"));
    } catch { /* try next */ }
  }
  try {
    return await import(join(root, "extensions/_shared/archive-rules.ts"));
  } catch (e) {
    console.error("Cannot load archive-rules.ts:", e);
    process.exit(2);
  }
}

const { validateArchiveEntries, CORE_CONFIG_FILES, RESERVED_CONFIG_FILES } = await loadModule();

let passed = 0;
let failed = 0;
function accepts(name, entries) {
  try {
    validateArchiveEntries(entries);
    passed++;
    console.log(`  ✓ accepts ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ should accept ${name} — ${e.message}`);
  }
}
function rejects(name, entries) {
  try {
    validateArchiveEntries(entries);
    failed++;
    console.error(`  ✗ should reject ${name}`);
  } catch (e) {
    passed++;
    console.log(`  ✓ rejects ${name} (${e.message.slice(0, 60)})`);
  }
}

console.log("validateArchiveEntries:");

// ── valid layouts ────────────────────────────────────────────────────────
accepts("classic v1.3 layout", ["config", "config/models.json", "config/settings.json", "config/auth.json", "skills", "skills/a/SKILL.md", "extensions", "extensions/x/index.ts"]);
accepts("v1.4 layout with manifest", ["manifest.json", "config/models.json", "config/settings.json", "config/auth.json", "config/mcp.json", "config/pi-fff.json", "skills", "extensions"]);
accepts("manifest only + config", ["manifest.json", "config/settings.json"]);
accepts("bare dirs", ["config", "skills", "extensions"]);
// NOTE: listArchiveEntries normalizes "./"-prefixed entries before validation
// (v1.3.3 fix); raw unnormalized entries are rejected by contract.
rejects("unnormalized ./ entry", ["./config/models.json"]);
accepts("plugin config allowlist file", ["config/open-tui.json"]);
accepts("dotted plugin config", ["config/pi-cache-optimizer.stats.json"]);
accepts("skills/extensions only", ["skills/a/SKILL.md", "extensions/b/index.ts"]);

// ── invalid layouts ──────────────────────────────────────────────────────
rejects("empty", []);
rejects("dot-only", [".", "./"]);
rejects("absolute path", ["/etc/passwd"]);
rejects("parent traversal", ["config/../evil.json"]);
rejects("windows drive", ["C:/Users/x/config/settings.json"]);
rejects("unknown top-level", ["README.md"]);
rejects("nested config path", ["config/sub/dir/settings.json"]);
rejects("reserved sync_config.json", ["config/sync_config.json"]);
rejects("reserved case variant", ["config/Sync_Config.JSON"]);
rejects("unsafe config name", ["config/../settings.json"]);
rejects("config name with slash-ish chars", ["config/a b.json"]);
rejects("manifest as directory", ["manifest.json", "manifest.json/evil"]);
rejects("case-colliding config names", ["config/settings.json", "config/SETTINGS.json"]);
rejects("non-json config file", ["config/settings.txt"]);

// ── constants sanity ─────────────────────────────────────────────────────
console.log("constants:");
const ok1 = CORE_CONFIG_FILES.includes("mcp.json") && CORE_CONFIG_FILES.length === 4;
console.log(`  ${ok1 ? "✓" : "✗"} CORE_CONFIG_FILES = ${JSON.stringify(CORE_CONFIG_FILES)}`);
ok1 ? passed++ : failed++;
const ok2 = RESERVED_CONFIG_FILES.has("sync_config.json");
console.log(`  ${ok2 ? "✓" : "✗"} sync_config.json reserved`);
ok2 ? passed++ : failed++;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
