#!/usr/bin/env node
/**
 * Tests for cross-system path portability (extensions/_shared/path-portability.ts).
 * Loads the REAL TypeScript module via jiti — no reimplementation.
 */
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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
      return await jiti.import(join(root, "extensions/_shared/path-portability.ts"));
    } catch { /* try next */ }
  }
  // Fallback: bun can import TS directly
  try {
    return await import(join(root, "extensions/_shared/path-portability.ts"));
  } catch (e) {
    console.error("Cannot load path-portability.ts (jiti not found, bun import failed):", e);
    process.exit(2);
  }
}

const mod = await loadModule();
const {
  parseManifest,
  rebaseConfigFile,
  rebaseContextFromManifest,
  splitUnderBase,
  isPathLikeValue,
  classifyUrl,
} = mod;

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ── Fixture: a fake target machine ───────────────────────────────────────
const targetHome = mkdtempSync(join(tmpdir(), "pi-sync-path-test-"));
const targetAgentDir = join(targetHome, ".pi", "agent");
mkdirSync(join(targetAgentDir, "extensions", "shellkeeper-guard"), { recursive: true });
writeFileSync(join(targetAgentDir, "extensions", "shellkeeper-guard", "index.ts"), "// ok", "utf-8");

const exists = (p) => existsSync(p);

// ── splitUnderBase ───────────────────────────────────────────────────────
console.log("splitUnderBase:");
check("linux under home", splitUnderBase("/home/alice/proj", "/home/alice", "linux") === "proj");
check("linux equal home", splitUnderBase("/home/alice", "/home/alice", "linux") === "");
check("prefix lookalike NOT under", splitUnderBase("/home/alice2/proj", "/home/alice", "linux") === undefined);
check("sibling NOT under", splitUnderBase("/home/bob/proj", "/home/alice", "linux") === undefined);
check("win backslash under", splitUnderBase("C:\\Users\\wxy\\proj", "C:\\Users\\wxy", "win32") === "proj");
check("win forward slash under", splitUnderBase("C:/Users/wxy/proj", "C:\\Users\\wxy", "win32") === "proj");
check("win case-insensitive", splitUnderBase("c:\\users\\WXY\\proj", "C:\\Users\\wxy", "win32") === "proj");
check("win different user NOT under", splitUnderBase("C:\\Users\\bob\\proj", "C:\\Users\\wxy", "win32") === undefined);

// ── isPathLikeValue ──────────────────────────────────────────────────────
console.log("isPathLikeValue:");
check("absolute posix", isPathLikeValue("/home/alice/x") === true);
check("windows drive", isPathLikeValue("C:\\Users\\wxy\\x") === true);
check("npm: not path", isPathLikeValue("npm:pi-markdown-preview") === false);
check("git: not path", isPathLikeValue("git:github.com/x/y") === false);
check("builtin: not path", isPathLikeValue("builtin:mcp") === false);
check("http not path", isPathLikeValue("http://127.0.0.1:3425/v1") === false);
check("tilde is path-like", isPathLikeValue("~/x") === true);
check("relative not path-like", isPathLikeValue("./local") === false);

// ── classifyUrl ──────────────────────────────────────────────────────────
console.log("classifyUrl:");
check("loopback", classifyUrl("http://127.0.0.1:3425/v1") === "loopback");
check("localhost loopback", classifyUrl("http://localhost:8080/") === "loopback");
check("ipv6 loopback", classifyUrl("http://[::1]:9000") === "loopback");
check("rfc1918 192.168", classifyUrl("http://192.168.8.180:8986") === "private");
check("rfc1918 10.x", classifyUrl("https://10.0.0.5/api") === "private");
check("external", classifyUrl("https://api.example.com/v1") === "external");
check("not url", classifyUrl("/home/alice") === "not-url");

// ── parseManifest ────────────────────────────────────────────────────────
console.log("parseManifest:");
const goodManifest = {
  version: 1,
  piSyncVersion: "1.4.0",
  createdAt: "2026-07-14T00:00:00Z",
  source: { platform: "linux", platformTag: "linux", home: "/home/alice", agentDir: "/home/alice/.pi/agent" },
};
check("valid manifest", parseManifest(goodManifest).source.home === "/home/alice");
let threw = false;
try { parseManifest({ version: 2 }); } catch { threw = true; }
check("unsupported version throws", threw);
threw = false;
try { parseManifest({ version: 1, source: { platform: "linux" } }); } catch { threw = true; }
check("incomplete source throws", threw);
threw = false;
try { parseManifest("nope"); } catch { threw = true; }
check("non-object throws", threw);

// ── rebaseConfigFile: settings.json (linux → linux) ──────────────────────
console.log("rebase settings.json (linux→linux):");
const linuxCtx = rebaseContextFromManifest(
  parseManifest(goodManifest),
  targetHome,
  targetAgentDir,
  exists,
);
const settings = {
  packages: ["npm:pi-markdown-preview", "git:github.com/wxyttty/pi-sync@1.3.8", "./local-pkg"],
  defaultModel: "wg/glm-5.3",
  extensions: ["/home/alice/ai-guard-eval/shellkeeper-guard/index.ts"],
  skills: ["!/home/alice/noisy-skill"],
  externalEditor: "/home/alice/bin/editor",
  sessionDir: "/home/alice/sessions",
  shellPath: "/bin/bash",
  npmCommand: ["/home/alice/bin/npm"],
};
{
  const r = rebaseConfigFile("settings.json", settings, linuxCtx);
  const v = r.value;
  check("extensions[0] rebased to target home",
    v.extensions[0] === join(targetHome, "ai-guard-eval/shellkeeper-guard/index.ts"),
    `got ${v.extensions[0]}`);
  check("rebase recorded with field name",
    r.rebases.some((x) => x.field === "settings.extensions[0]" && x.from === "/home/alice/ai-guard-eval/shellkeeper-guard/index.ts"));
  check("rebase exists=false (target missing)", r.rebases[0].exists === false);
  check("missing-path warning emitted",
    r.warnings.some((w) => w.kind === "missing-path" && w.field === "settings.extensions[0]"));
  check("skills ! prefix preserved",
    v.skills[0] === "!" + join(targetHome, "noisy-skill"),
    `got ${v.skills[0]}`);
  check("externalEditor rebased", v.externalEditor === join(targetHome, "bin/editor"));
  check("sessionDir rebased", v.sessionDir === join(targetHome, "sessions"));
  check("shellPath untouched (outside source home)", v.shellPath === "/bin/bash");
  check("packages npm:/git: untouched", v.packages[0] === "npm:pi-markdown-preview" && v.packages[1] === "git:github.com/wxyttty/pi-sync@1.3.8");
  check("local package reported", r.warnings.some((w) => w.kind === "local-package" && w.field === "settings.packages[2]"));
  check("npmCommand path reported (not rewritten)", v.npmCommand[0] === "/home/alice/bin/npm" && r.warnings.some((w) => w.field === "settings.npmCommand[0]"));
  check("input object not mutated", settings.extensions[0] === "/home/alice/ai-guard-eval/shellkeeper-guard/index.ts");
}

// ── rebaseConfigFile: agent-dir priority ─────────────────────────────────
console.log("rebase agent-dir priority:");
{
  const r = rebaseConfigFile("settings.json", { extensions: ["/home/alice/.pi/agent/extensions/foo/index.ts"] }, linuxCtx);
  check("agent-dir path rebased to target AGENT dir",
    r.value.extensions[0] === join(targetAgentDir, "extensions", "foo", "index.ts"),
    `got ${r.value.extensions[0]}`);
}
{
  // The synced extension exists in the target agent dir → exists=true, no missing warning
  const r = rebaseConfigFile("settings.json", { extensions: ["/home/alice/.pi/agent/extensions/shellkeeper-guard/index.ts"] }, linuxCtx);
  check("existing synced extension → exists=true",
    r.rebases[0].exists === true && !r.warnings.some((w) => w.kind === "missing-path" && w.field === "settings.extensions[0]"));
}

// ── rebaseConfigFile: mcp.json ───────────────────────────────────────────
console.log("rebase mcp.json:");
const mcp = {
  mcpServers: {
    oce: {
      command: "npx",
      args: ["ace-tool-rs", "--base-url", "http://192.168.8.180:8986"],
    },
    local: {
      command: "/home/alice/.pi/agent/extensions/mcp-server/bin/server",
      cwd: "/home/alice/work",
      args: ["--config", "/home/alice/cfg.json"],
      env: { TOKEN_CMD: "cat /home/alice/.secret" },
    },
    remote: { url: "https://mcp.exa.ai/mcp?exaApiKey=x" },
  },
};
{
  const r = rebaseConfigFile("mcp.json", mcp, linuxCtx);
  const v = r.value;
  check("plain command untouched", v.mcpServers.oce.command === "npx");
  check("LAN url arg reported", r.warnings.some((w) => w.field === "mcp.mcpServers.oce.args[2]" && w.kind === "private-url"));
  check("absolute command rebased", v.mcpServers.local.command === join(targetAgentDir, "extensions/mcp-server/bin/server"));
  check("cwd rebased", v.mcpServers.local.cwd === join(targetHome, "work"));
  check("whole-path arg rebased", v.mcpServers.local.args[1] === join(targetHome, "cfg.json"));
  check("non-path arg untouched", v.mcpServers.local.args[0] === "--config");
  check("env command path reported (not rewritten)", v.mcpServers.local.env.TOKEN_CMD === "cat /home/alice/.secret" && r.warnings.some((w) => w.field === "mcp.mcpServers.local.env.TOKEN_CMD"));
  check("remote url untouched, no warning", v.mcpServers.remote.url === "https://mcp.exa.ai/mcp?exaApiKey=x" && !r.warnings.some((w) => w.field.includes("remote")));
}

// ── rebaseConfigFile: models.json ────────────────────────────────────────
console.log("rebase models.json:");
const models = {
  providers: {
    magpie: { api: "openai-completions", baseUrl: "http://127.0.0.1:3425/v1", apiKey: "x" },
    remote: { api: "openai-completions", baseUrl: "https://api.example.com/v1" },
    local: { api: "openai-completions", baseUrl: "http://192.168.1.10:8000/v1", apiKeyCommand: "cat /home/alice/.key" },
  },
};
{
  const r = rebaseConfigFile("models.json", models, linuxCtx);
  check("loopback baseUrl reported", r.warnings.some((w) => w.field === "models.providers.magpie.baseUrl" && w.kind === "loopback-url"));
  check("private baseUrl reported", r.warnings.some((w) => w.field === "models.providers.local.baseUrl" && w.kind === "private-url"));
  check("external baseUrl clean", !r.warnings.some((w) => w.field === "models.providers.remote.baseUrl"));
  check("baseUrl NOT rewritten", r.value.providers.magpie.baseUrl === "http://127.0.0.1:3425/v1");
  check("apiKeyCommand reported (not rewritten)", r.value.providers.local.apiKeyCommand === "cat /home/alice/.key" && r.warnings.some((w) => w.field === "models.providers.local.apiKeyCommand"));
}

// ── rebaseConfigFile: Windows source → Linux target ──────────────────────
console.log("rebase Windows→Linux:");
const winManifest = parseManifest({
  version: 1,
  piSyncVersion: "1.4.0",
  createdAt: "2026-07-14T00:00:00Z",
  source: { platform: "win32", platformTag: "windows11", home: "C:\\Users\\wxy", agentDir: "C:\\Users\\wxy\\.pi\\agent" },
});
const winCtx = rebaseContextFromManifest(winManifest, targetHome, targetAgentDir, exists);
{
  const r = rebaseConfigFile("settings.json", {
    extensions: ["C:\\Users\\wxy\\ai-guard-eval\\shellkeeper-guard\\index.ts"],
    skills: ["C:/Users/wxy/dev-skills"],
  }, winCtx);
  check("win backslash path rebased to posix",
    r.value.extensions[0] === join(targetHome, "ai-guard-eval", "shellkeeper-guard", "index.ts"),
    `got ${r.value.extensions[0]}`);
  check("win forward-slash path rebased",
    r.value.skills[0] === join(targetHome, "dev-skills"),
    `got ${r.value.skills[0]}`);
}
{
  const r = rebaseConfigFile("mcp.json", {
    mcpServers: { s: { command: "C:\\Users\\wxy\\.pi\\agent\\extensions\\srv\\srv.exe", cwd: "C:\\Users\\wxy\\work" } },
  }, winCtx);
  check("win agent-dir command rebased",
    r.value.mcpServers.s.command === join(targetAgentDir, "extensions", "srv", "srv.exe"),
    `got ${r.value.mcpServers.s.command}`);
  check("win cwd rebased", r.value.mcpServers.s.cwd === join(targetHome, "work"));
}

// ── rebaseConfigFile: unknown plugin config → report-only ────────────────
console.log("rebase unknown plugin config (report-only):");
{
  const pluginCfg = { toolPath: "/home/alice/tools/t.sh", label: "my tool", count: 3 };
  const r = rebaseConfigFile("pi-fff.json", pluginCfg, linuxCtx);
  check("value untouched", r.value.toolPath === "/home/alice/tools/t.sh");
  check("rebase recorded? NO", r.rebases.length === 0);
  check("warning emitted", r.warnings.some((w) => w.kind === "unrebased-path" && w.field === "pi-fff.json.toolPath"));
}

// ── tilde values pass through untouched ──────────────────────────────────
console.log("tilde passthrough:");
{
  const r = rebaseConfigFile("settings.json", { extensions: ["~/dev/ext/index.ts"], shellPath: "~/.local/bin/zsh" }, linuxCtx);
  check("~/ extension untouched", r.value.extensions[0] === "~/dev/ext/index.ts");
  check("~ shellPath untouched", r.value.shellPath === "~/.local/bin/zsh");
  check("no rebases", r.rebases.length === 0);
}

// ── edge cases: separators, drive roots, POSIX backslashes ───────────────
console.log("separator edge cases:");
check("trailing separator on value", splitUnderBase("/home/alice/", "/home/alice", "linux") === "");
check("trailing separator on base", splitUnderBase("/home/alice/x", "/home/alice/", "linux") === "x");
check("repeated separators", splitUnderBase("//home//alice//x", "/home/alice", "linux") === "x");
check("repeated separators on base", splitUnderBase("/home/alice/x", "//home//alice", "linux") === "x");
check("posix literal backslash kept", splitUnderBase("/home/alice/my\\file", "/home/alice", "linux") === "my\\file");
check("win drive root base", splitUnderBase("C:\\Users\\wxy", "C:\\", "win32") === "Users\\wxy");
check("win drive root base no slash", splitUnderBase("C:\\Users\\wxy", "C:", "win32") === "Users\\wxy");
check("win value equals drive root", splitUnderBase("C:\\", "C:\\", "win32") === "");
check("win repeated separators", splitUnderBase("C:\\Users\\\\wxy", "C:\\Users", "win32") === "wxy");

{
  // POSIX literal backslash survives the rebase as one filename
  const r = rebaseConfigFile("settings.json", { extensions: ["/home/alice/my\\file"] }, linuxCtx);
  check("posix backslash filename rebased as single part",
    r.value.extensions[0] === join(targetHome, "my\\file"), `got ${r.value.extensions[0]}`);
}

// ── externalEditor: bare path vs command string ──────────────────────────
console.log("externalEditor:");
{
  const r = rebaseConfigFile("settings.json", { externalEditor: "/home/alice/bin/editor --wait" }, linuxCtx);
  check("command with args NOT rebased", r.value.externalEditor === "/home/alice/bin/editor --wait");
  check("command with args reported", r.warnings.some((w) => w.field === "settings.externalEditor" && w.kind === "command-path"));
  check("no rebase recorded for command", r.rebases.length === 0);
}
{
  const r = rebaseConfigFile("settings.json", { externalEditor: "/home/alice/bin/editor" }, linuxCtx);
  check("bare path rebased", r.value.externalEditor === join(targetHome, "bin", "editor"));
}

// ── manifest root validation ──────────────────────────────────────────────
console.log("manifest validation:");
threw = false;
try { parseManifest({ version: 1, source: { platform: "linux", home: "relative/path", agentDir: "/abs" } }); } catch { threw = true; }
check("relative home rejected", threw);
threw = false;
try { parseManifest({ version: 1, source: { platform: "win32", home: "/home/alice", agentDir: "C:\\x" } }); } catch { threw = true; }
check("posix home on win32 platform rejected", threw);
threw = false;
try { parseManifest({ version: 1, source: { platform: "not a platform!", home: "/x", agentDir: "/x" } }); } catch { threw = true; }
check("invalid platform id rejected", threw);
threw = false;
try { parseManifest({ version: 1, source: { platform: "win32", home: "C:\\Users\\wxy", agentDir: "\\\\server\\share\\pi" } }); } catch { threw = true; }
check("UNC agentDir accepted", !threw);

// ── scalar array leaves are scanned ───────────────────────────────────────
console.log("scalar array leaves:");
{
  const r = rebaseConfigFile("pi-fff.json", { paths: ["/home/alice/tools", "/other"], nested: [{ cfg: "/home/alice/x" }] }, linuxCtx);
  check("array scalar path warned", r.warnings.some((w) => w.field === "pi-fff.json.paths[0]" && w.kind === "unrebased-path"));
  check("array non-path not warned", !r.warnings.some((w) => w.field === "pi-fff.json.paths[1]"));
  check("object-in-array leaf warned", r.warnings.some((w) => w.field === "pi-fff.json.nested[0].cfg"));
}
{
  // legacy settings.extensions arrays are scanned too
  const r = rebaseConfigFile("pi-fff.json", { extensions: ["/home/alice/dev/ext"] }, linuxCtx);
  check("legacy-style extensions array scanned", r.warnings.some((w) => w.field === "pi-fff.json.extensions[0]"));
}

// ── dedup: rebased fields not re-reported by generic scan ────────────────
console.log("dedup:");
{
  const r = rebaseConfigFile("settings.json", { extensions: ["/home/alice/x"] }, linuxCtx);
  const fields = r.warnings.filter((w) => w.field === "settings.extensions[0]").map((w) => w.kind);
  check("rebased field has only the missing-path warning", fields.length === 1 && fields[0] === "missing-path", JSON.stringify(fields));
}
{
  // URL query secrets are redacted in warnings
  const r = rebaseConfigFile("pi-fff.json", { url: "http://127.0.0.1:8080/x?token=SECRETSECRET" }, linuxCtx);
  const w = r.warnings.find((x) => x.field === "pi-fff.json.url");
  check("loopback in unknown field warned", Boolean(w));
  check("query secret redacted", w && !w.value.includes("SECRETSECRET"), `got ${w && w.value}`);
}

// ── cleanup ──────────────────────────────────────────────────────────────
rmSync(targetHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
