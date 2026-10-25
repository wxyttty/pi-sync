#!/usr/bin/env node
/**
 * End-to-end integration test for the /sync restore flow.
 *
 * Drives the REAL extension (extensions/sync/index.ts) through a mock Pi
 * ExtensionAPI + a local mock WebDAV server:
 *   download → list entries → validate → stage → manifest → rebase →
 *   preview (captured) → confirm → apply → report (captured)
 *
 * The target agent dir is a temp dir via PI_CODING_AGENT_DIR, so the real
 * ~/.pi/agent is never touched.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  rmSync, readdirSync, symlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

// ── Load the real extension via jiti ─────────────────────────────────────
// The extension imports @earendil-works/pi-tui (value import). Resolution works
// through a repo-local node_modules symlink into Pi's install tree (gitignored).
function ensureNodeModulesLink() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const linkPath = join(root, "node_modules");
  const candidates = [
    join(home, ".pi/agent/install/releases", process.env.PI_RELEASE || "1.4.0", "node_modules"),
  ];
  for (const c of candidates) {
    if (!existsSync(join(c, "@earendil-works", "pi-tui"))) continue;
    try {
      if (existsSync(linkPath)) return true;
      symlinkSync(c, linkPath, "dir");
      return true;
    } catch { /* fall through */ }
  }
  return false;
}

async function loadExtension() {
  if (!ensureNodeModulesLink()) return null;
  const require = createRequire(import.meta.url);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const jitiCandidates = [
    join(home, ".pi/agent/install/releases", process.env.PI_RELEASE || "1.4.0", "node_modules/jiti/lib/jiti.cjs"),
    join(home, ".pi/agent/npm/node_modules/jiti/lib/jiti.cjs"),
  ];
  for (const jp of jitiCandidates) {
    try {
      const { createJiti } = require(jp);
      const jiti = createJiti(import.meta.url);
      return await jiti.import(join(root, "extensions/sync/index.ts"));
    } catch (e) {
      console.error(`  (jiti candidate failed: ${jp}: ${e.message})`);
    }
  }
  return null;
}

// ── Fixtures ─────────────────────────────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), "pi-sync-e2e-"));
const targetAgentDir = join(workDir, "target-agent");
mkdirSync(targetAgentDir, { recursive: true });

// Pre-existing local settings.json (gets a .bak safety copy)
writeFileSync(join(targetAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:old-pkg"] }, null, 2), "utf-8");

// Source archive content (built by hand so the manifest can lie about the source machine)
const srcStage = join(workDir, "src-stage");
mkdirSync(join(srcStage, "config"), { recursive: true });
mkdirSync(join(srcStage, "skills", "hello"), { recursive: true });
mkdirSync(join(srcStage, "extensions", "shellkeeper-guard"), { recursive: true });

writeFileSync(join(srcStage, "manifest.json"), JSON.stringify({
  version: 1,
  piSyncVersion: "1.4.0",
  createdAt: "2026-07-14T00:00:00.000Z",
  source: { platform: "linux", platformTag: "linux", home: "/home/alice", agentDir: "/home/alice/.pi/agent" },
}, null, 2), "utf-8");

writeFileSync(join(srcStage, "config", "settings.json"), JSON.stringify({
  packages: ["npm:pi-markdown-preview", "git:github.com/wxyttty/pi-sync@1.4.0"],
  defaultModel: "wg/glm-5.3",
  extensions: ["/home/alice/ai-guard-eval/shellkeeper-guard/index.ts", "~/dev/other-ext/index.ts"],
  skills: ["!/home/alice/noisy-skill"],
}, null, 2), "utf-8");

writeFileSync(join(srcStage, "config", "models.json"), JSON.stringify({
  providers: {
    magpie: { api: "openai-completions", baseUrl: "http://127.0.0.1:3425/v1", apiKey: "k" },
  },
}, null, 2), "utf-8");

writeFileSync(join(srcStage, "config", "mcp.json"), JSON.stringify({
  mcpServers: {
    local: { command: "/home/alice/.pi/agent/extensions/mcp-srv/bin/srv", args: ["--cfg", "/home/alice/cfg.json"] },
  },
}, null, 2), "utf-8");

writeFileSync(join(srcStage, "config", "pi-fff.json"), JSON.stringify({
  enableHomeDirScanning: false,
  toolPath: "/home/alice/tools/t.sh",
}, null, 2), "utf-8");

writeFileSync(join(srcStage, "skills", "hello", "SKILL.md"), "# hello\n", "utf-8");
writeFileSync(join(srcStage, "extensions", "shellkeeper-guard", "index.ts"), "// ext\n", "utf-8");

const backupName = "pi_sync_backup_2026-07-14_20260714120000_linux.tar.gz";
const archivePath = join(workDir, backupName);
execFileSync("tar", ["-c", "-z", "-f", archivePath, "-C", srcStage, "."]);

// ── Mock WebDAV server ───────────────────────────────────────────────────
const uploads = [];
const server = createServer((req, res) => {
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      uploads.push({ url: req.url, body: Buffer.concat(chunks) });
      res.writeHead(201);
      res.end();
    });
    return;
  }
  if (req.method === "PROPFIND") {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/${backupName}</d:href><d:propstat><d:prop><d:displayname>${backupName}</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
    res.writeHead(207, { "Content-Type": "application/xml" });
    res.end(xml);
    return;
  }
  if (req.method === "GET" && req.url === `/${backupName}`) {
    const buf = readFileSync(archivePath);
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(buf);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const davUrl = `http://127.0.0.1:${server.address().port}/`;

// ── Target sync_config.json (in the temp agent dir) ─────────────────────
process.env.PI_CODING_AGENT_DIR = targetAgentDir;
writeFileSync(join(targetAgentDir, "sync_config.json"), JSON.stringify({
  version: 2,
  activeProfile: "default",
  profiles: {
    default: {
      name: "default",
      backend: "webdav",
      webdavUrl: davUrl,
      webdavUser: "u",
      webdavPass: "p",
      backupProviders: true,
      backupSkills: true,
      backupExtensions: true,
      extraConfigFiles: ["pi-fff.json"],
    },
  },
}, null, 2), "utf-8");

// ── Load extension AFTER env is set (SYNC_CONFIG_PATH resolves at import) ─
const ext = await loadExtension();
if (!ext || !ext.default) {
  console.error("SKIP: cannot load extension via jiti in this environment");
  server.close();
  rmSync(workDir, { recursive: true, force: true });
  process.exit(2);
}

// ── Mock Pi API + ctx ────────────────────────────────────────────────────
let handler = null;
const mockPi = {
  registerCommand: (name, def) => { handler = def.handler; },
};
ext.default(mockPi);
check("command handler registered", typeof handler === "function");

const notifications = [];
let confirmMessages = [];
let reloadCalled = false;
const selectQueue = [];
const mockCtx = {
  hasUI: false,
  signal: new AbortController().signal,
  reload: async () => { reloadCalled = true; },
  ui: {
    notify: (msg) => { notifications.push(msg); },
    confirm: async (title, message) => { confirmMessages.push(`${title}\n${message}`); return true; },
    input: async () => { throw new Error("unexpected input prompt"); },
    select: async (title, items) => {
      const next = selectQueue.shift();
      if (next === undefined) throw new Error(`unexpected select: ${title}`);
      const found = items.find((i) => i.includes(next));
      if (!found) throw new Error(`select item not found: ${next} in [${items.join(" | ")}]`);
      return found;
    },
  },
};

selectQueue.push("Download Backup", backupName, "Exit");
await handler({}, mockCtx);

// ── Assertions ───────────────────────────────────────────────────────────
console.log("flow:");
const confirmText = confirmMessages.find((m) => m.includes("Confirm Restore")) || "";
check("confirm dialog shown", confirmText.length > 0);
check("preview lists config files incl. mcp.json + pi-fff.json",
  confirmText.includes("mcp.json") && confirmText.includes("pi-fff.json"));
check("preview shows source machine", confirmText.includes("Source: linux") && confirmText.includes("/home/alice"));
check("preview shows rebase plan", confirmText.includes("/home/alice/ai-guard-eval") && confirmText.includes("→"));
check("preview warns about loopback provider",
  confirmText.includes("models.providers.magpie.baseUrl") && confirmText.includes("127.0.0.1:3425"));
check("preview warns about plugin-config path (report-only)",
  confirmText.includes("pi-fff.json:toolPath"));

console.log("applied files:");
const restoredSettings = JSON.parse(readFileSync(join(targetAgentDir, "settings.json"), "utf-8"));
check("settings.json extensions[0] rebased to real home",
  restoredSettings.extensions[0] === join(homedir(), "ai-guard-eval", "shellkeeper-guard", "index.ts"),
  `got ${restoredSettings.extensions[0]}`);
check("settings.json ~/ entry untouched", restoredSettings.extensions[1] === "~/dev/other-ext/index.ts");
check("settings.json skills ! prefix + rebased",
  restoredSettings.skills[0] === "!" + join(homedir(), "noisy-skill"), `got ${restoredSettings.skills[0]}`);
check("settings.json packages untouched",
  restoredSettings.packages[0] === "npm:pi-markdown-preview");

const restoredMcp = JSON.parse(readFileSync(join(targetAgentDir, "mcp.json"), "utf-8"));
check("mcp.json command rebased to target agent dir",
  restoredMcp.mcpServers.local.command === join(targetAgentDir, "extensions", "mcp-srv", "bin", "srv"),
  `got ${restoredMcp.mcpServers.local.command}`);
check("mcp.json whole-path arg rebased",
  restoredMcp.mcpServers.local.args[1] === join(homedir(), "cfg.json"));

const restoredModels = JSON.parse(readFileSync(join(targetAgentDir, "models.json"), "utf-8"));
check("models.json loopback baseUrl restored as-is",
  restoredModels.providers.magpie.baseUrl === "http://127.0.0.1:3425/v1");

const restoredFff = JSON.parse(readFileSync(join(targetAgentDir, "pi-fff.json"), "utf-8"));
check("pi-fff.json restored verbatim (report-only)", restoredFff.toolPath === "/home/alice/tools/t.sh");

check("manifest.json NOT restored into agent dir", !existsSync(join(targetAgentDir, "manifest.json")));
check("sync_config.json untouched", existsSync(join(targetAgentDir, "sync_config.json")));
check("skills restored", readFileSync(join(targetAgentDir, "skills", "hello", "SKILL.md"), "utf-8").includes("hello"));
check("extensions restored", existsSync(join(targetAgentDir, "extensions", "shellkeeper-guard", "index.ts")));
check("safety .bak created for settings.json",
  readdirSync(targetAgentDir).some((f) => f.startsWith("settings.json.bak-")));

const report = notifications.join("\n");
check("report includes Path portability section", report.includes("Path portability"));
check("report includes rebase lines", report.includes("settings.extensions[0]"));
check("report includes packages diff (+ npm:pi-markdown-preview)", report.includes("+ npm:pi-markdown-preview"));
check("report includes missing-path warning", report.includes("missing") || report.includes("does not exist"));

// ── Upload phase: pack the target agent dir and inspect the archive ─────
console.log("upload:");
// Populate the (already-restored) agent dir as the new source.
writeFileSync(join(targetAgentDir, "auth.json"), "{}", "utf-8");

selectQueue.length = 0;
confirmMessages.length = 0;
selectQueue.push("Upload Backup", "Exit");
await handler({}, mockCtx);

check("upload performed exactly one PUT", uploads.length === 1, `got ${uploads.length}`);
if (uploads.length === 1) {
  const upPath = join(workDir, "uploaded.tar.gz");
  writeFileSync(upPath, uploads[0].body);
  check("upload URL is the archive filename", uploads[0].url === "/" + uploads[0].url.split("/").pop() && /pi_sync_backup_.*\.tar\.gz$/.test(uploads[0].url));
  const listOut = execFileSync("tar", ["-t", "-z", "-f", upPath]).toString();
  check("archive contains manifest.json", listOut.includes("manifest.json"));
  check("archive contains mcp.json", listOut.includes("config/mcp.json"));
  check("archive contains extra config pi-fff.json", listOut.includes("config/pi-fff.json"));
  check("archive contains settings/models/auth", listOut.includes("config/settings.json") && listOut.includes("config/models.json") && listOut.includes("config/auth.json"));
  check("archive contains skills + extensions", listOut.includes("skills/") && listOut.includes("extensions/"));

  // Extract and inspect the manifest
  const upStage = join(workDir, "up-stage");
  mkdirSync(upStage, { recursive: true });
  execFileSync("tar", ["-x", "-z", "-f", upPath, "-C", upStage]);
  const upManifest = JSON.parse(readFileSync(join(upStage, "manifest.json"), "utf-8"));
  check("manifest records this machine's home", upManifest.source.home === homedir());
  check("manifest records PI_CODING_AGENT_DIR agent dir", upManifest.source.agentDir === targetAgentDir);
  check("manifest version 1 + platform", upManifest.version === 1 && typeof upManifest.source.platform === "string");
  check("manifest NOT restored into agent dir (upload side n/a)", !existsSync(join(targetAgentDir, "manifest.json")));
  check("sync_config.json NOT inside archive", !listOut.includes("sync_config.json"));
}

// ── Cleanup ──────────────────────────────────────────────────────────────
server.close();
rmSync(workDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
