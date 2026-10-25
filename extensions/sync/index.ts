import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { timestampForBackup, ensureDir, writeJsonAtomic, readJsonSafe } from "../_shared/json-io";
import { getAgentDir } from "../_shared/agent-dirs";
import {
  AGENT_CONFIG_FILES,
  CORE_CONFIG_FILES,
  RESERVED_CONFIG_FILES,
  SAFE_CONFIG_NAME_RE,
  validateArchiveEntries,
} from "../_shared/archive-rules";
import {
  classifyUrl,
  parseManifest,
  redactValue,
  rebaseConfigFile,
  rebaseContextFromManifest,
  type PathRebase,
  type PortabilityWarning,
  type SyncManifest,
} from "../_shared/path-portability";
import { enhancedSelect } from "../_shared/enhanced-select";
import { runCommand } from "../_shared/spawn";
import { fetchWithTimeout } from "../_shared/fetch-utils";
import {
  buildS3Url,
  parseListObjectsV2Keys,
  sha256Hex,
  signAwsV4,
} from "../_shared/s3-sigv4";
import { extractZipToDir, isZipFile, isZipSecurityError, listZipEntries } from "../_shared/zip-utils";

/** Host platform tag for backup filenames (windows11/macos/linux/…). */
function platformTag(): string {
  const p = os.platform();
  if (p === "win32") {
    // Windows 11 is build >= 22000; earlier builds report as Windows 10.
    const build = parseInt((os.release().split(".")[2] ?? "0"), 10);
    return build >= 22000 ? "windows11" : "windows10";
  }
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  return p; // fallback: raw platform id (e.g. "freebsd")
}

/** Zero-padded local calendar date for filenames: 2026-07-04 (not 2026-7-4). */
function formatBackupDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Compact UTC stamp: 20260704123045 — primary sort key for backup lists. */
function formatBackupTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Sort key for pi_sync_backup_* names so lexicographic order matches time.
 * Prefer the 14-digit timestamp segment; fall back to zero-padded date segment.
 */
function backupSortKey(name: string): string {
  const base = name.replace(/\.(tar\.gz|tgz|zip)$/i, "");
  const ts = base.match(/_(\d{14})(?:_|$)/);
  if (ts) return ts[1];
  // pad unpadded dates like 2026-7-4 → 2026-07-04 for legacy archives
  const datePart = base.match(/pi_sync_backup_(\d{4}-\d{1,2}-\d{1,2})/);
  if (datePart) {
    const [y, m, d] = datePart[1].split("-");
    return `${y}${m.padStart(2, "0")}${d.padStart(2, "0")}000000`;
  }
  return base;
}

function sortBackupNamesNewestFirst(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const kb = backupSortKey(b);
    const ka = backupSortKey(a);
    if (ka !== kb) return kb.localeCompare(ka);
    return b.localeCompare(a);
  });
}

/** Let TUI paint before long sync fs work. */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Default settings file to store user configuration
const SYNC_CONFIG_PATH = path.join(getAgentDir(), "sync_config.json");
const TAR_TIMEOUT_MS = 300_000;
const CLOUD_FETCH_TIMEOUT_MS = 120_000;

/** pi-sync version stamped into backup manifests. */
const PI_SYNC_VERSION = "1.4.1";

type SyncBackend = "webdav" | "s3";

interface SyncConfig {
  /** Optional display name for multi-profile UI (not required for old files). */
  name?: string;
  /** Storage backend. Defaults to webdav when omitted (backward compatible). */
  backend: SyncBackend;
  // ── WebDAV ──
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string; // Environment variable or plaintext
  // ── S3-compatible ──
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  /** Optional session token (temporary credentials). */
  s3SessionToken: string;
  /** Optional custom endpoint (MinIO / R2 / OSS). Empty = AWS. */
  s3Endpoint: string;
  /** Object key prefix inside the bucket, e.g. "pi-backups/". */
  s3Prefix: string;
  /** Force path-style URLs. Default true when s3Endpoint is set. */
  s3ForcePathStyle: boolean;
  // ── What to include ──
  backupProviders: boolean;
  backupSkills: boolean;
  backupExtensions: boolean;
  /**
   * Explicit allowlist of extra agent-root config files to sync (plugin
   * configs like pi-fff.json). Empty by default — discovery is opt-in.
   */
  extraConfigFiles: string[];
  /**
   * Agent-level config: ~/.pi/web-search.json, <agentDir>/AGENTS.md,
   * <agentDir>/pi-blackhole/pi-blackhole-config.json (archive dir agent-config/).
   */
  backupAgentConfig: boolean;
}

/** Multi-profile store written to sync_config.json (v2). */
interface SyncStore {
  version: 2;
  activeProfile: string;
  profiles: Record<string, SyncConfig>;
}

const DEFAULT_PROFILE_ID = "default";

function defaultConfig(name = "default"): SyncConfig {
  return {
    name,
    backend: "webdav",
    webdavUrl: "",
    webdavUser: "",
    webdavPass: "",
    s3Bucket: "",
    s3Region: "us-east-1",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3SessionToken: "",
    s3Endpoint: "",
    s3Prefix: "pi-backups/",
    s3ForcePathStyle: true,
    backupProviders: true,
    backupSkills: true,
    backupExtensions: true,
    extraConfigFiles: [],
    backupAgentConfig: true,
  };
}

/** Sanitize the extra-config allowlist: plain *.json names, no reserved/core files. */
function sanitizeExtraConfigFiles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const name = path.basename(v.trim().replace(/\\/g, "/"));
    if (!SAFE_CONFIG_NAME_RE.test(name)) continue;
    if (RESERVED_CONFIG_FILES.has(name.toLowerCase())) continue;
    if ((CORE_CONFIG_FILES as string[]).includes(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function normalizePrefix(prefix: string): string {
  let p = (prefix || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (p && !p.endsWith("/")) p += "/";
  return p;
}

function sanitizeProfileId(raw: string): string {
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || DEFAULT_PROFILE_ID;
}

function normalizeConfig(data: Partial<SyncConfig> | undefined, fallbackName?: string): SyncConfig {
  const defaults = defaultConfig(fallbackName || "default");
  const d = data || {};
  const backend: SyncBackend =
    d.backend === "s3" || d.backend === "webdav"
      ? d.backend
      : d.webdavUrl
        ? "webdav"
        : d.s3Bucket
          ? "s3"
          : "webdav";

  return {
    name: (d.name || fallbackName || defaults.name || "default").trim() || "default",
    backend,
    webdavUrl: d.webdavUrl || "",
    webdavUser: d.webdavUser || "",
    webdavPass: d.webdavPass || "",
    s3Bucket: d.s3Bucket || "",
    s3Region: d.s3Region || defaults.s3Region,
    s3AccessKeyId: d.s3AccessKeyId || "",
    s3SecretAccessKey: d.s3SecretAccessKey || "",
    s3SessionToken: d.s3SessionToken || "",
    s3Endpoint: d.s3Endpoint || "",
    s3Prefix: normalizePrefix(d.s3Prefix ?? defaults.s3Prefix),
    s3ForcePathStyle:
      typeof d.s3ForcePathStyle === "boolean"
        ? d.s3ForcePathStyle
        : d.s3Endpoint
          ? true
          : false,
    backupProviders: d.backupProviders !== false,
    backupSkills: d.backupSkills !== false,
    backupExtensions: d.backupExtensions !== false,
    extraConfigFiles: sanitizeExtraConfigFiles(d.extraConfigFiles),
    backupAgentConfig: d.backupAgentConfig !== false,
  };
}

/** Detect legacy flat config (v1) vs multi-profile store (v2). */
function isLegacyFlatConfig(raw: Record<string, unknown>): boolean {
  if (raw.version === 2 && raw.profiles && typeof raw.profiles === "object") return false;
  return (
    ("webdavUrl" in raw ||
      "webdavUser" in raw ||
      "s3Bucket" in raw ||
      "backupProviders" in raw ||
      "backend" in raw) &&
    !("profiles" in raw)
  );
}

function emptyStore(): SyncStore {
  return {
    version: 2,
    activeProfile: DEFAULT_PROFILE_ID,
    profiles: { [DEFAULT_PROFILE_ID]: defaultConfig("default") },
  };
}

export default function (pi: ExtensionAPI) {
  function loadStore(): SyncStore {
    const raw = readJsonSafe<Record<string, unknown>>(SYNC_CONFIG_PATH, {});
    if (!raw || Object.keys(raw).length === 0) return emptyStore();

    if (raw.version === 2 && raw.profiles && typeof raw.profiles === "object") {
      const profilesIn = raw.profiles as Record<string, Partial<SyncConfig>>;
      const profiles: Record<string, SyncConfig> = {};
      for (const [id, cfg] of Object.entries(profilesIn)) {
        const sid = sanitizeProfileId(id);
        profiles[sid] = normalizeConfig(cfg, cfg?.name || sid);
      }
      if (Object.keys(profiles).length === 0) {
        profiles[DEFAULT_PROFILE_ID] = defaultConfig("default");
      }
      let active =
        typeof raw.activeProfile === "string" ? sanitizeProfileId(raw.activeProfile) : DEFAULT_PROFILE_ID;
      if (!profiles[active]) active = Object.keys(profiles).sort()[0];
      return { version: 2, activeProfile: active, profiles };
    }

    if (isLegacyFlatConfig(raw)) {
      const cfg = normalizeConfig(raw as Partial<SyncConfig>, "default");
      return {
        version: 2,
        activeProfile: DEFAULT_PROFILE_ID,
        profiles: { [DEFAULT_PROFILE_ID]: cfg },
      };
    }

    return emptyStore();
  }

  function saveStore(store: SyncStore) {
    ensureDir(path.dirname(SYNC_CONFIG_PATH));
    const out: SyncStore = {
      version: 2,
      activeProfile: store.activeProfile,
      profiles: store.profiles,
    };
    writeJsonAtomic(SYNC_CONFIG_PATH, out, { backup: true });
  }

  function loadConfig(): SyncConfig {
    const store = loadStore();
    return store.profiles[store.activeProfile] || defaultConfig(store.activeProfile);
  }

  function saveConfig(config: SyncConfig) {
    const store = loadStore();
    const id = store.activeProfile || DEFAULT_PROFILE_ID;
    store.profiles[id] = normalizeConfig(config, config.name || id);
    store.activeProfile = id;
    saveStore(store);
  }

  function listProfileIds(store: SyncStore): string[] {
    return Object.keys(store.profiles).sort((a, b) => {
      if (a === store.activeProfile) return -1;
      if (b === store.activeProfile) return 1;
      return a.localeCompare(b);
    });
  }

  function profileSummary(id: string, cfg: SyncConfig, active: boolean): string {
    const mark = active ? "●" : "○";
    const label = cfg.name && cfg.name !== id ? `${cfg.name} (${id})` : id;
    const dest =
      cfg.backend === "s3"
        ? `S3 ${cfg.s3Bucket || "?"}/${cfg.s3Prefix || ""}`
        : `WebDAV ${cfg.webdavUrl ? cfg.webdavUrl.replace(/^https?:\/\//, "").slice(0, 40) : "?"}`;
    const ready = isBackendConfigured(cfg) ? "ready" : "incomplete";
    return `${mark} ${label} — ${dest} [${ready}]`;
  }

  function resolveSecret(value: string): string {
    if (value.startsWith("$")) {
      const envVar = value.slice(1);
      return process.env[envVar] ?? value;
    }
    return value;
  }

  /** Safe error-to-string (never recurse). */
  function formatError(e: unknown): string {
    if (e instanceof Error) return e.message || e.name || "Error";
    try {
      return String(e);
    } catch {
      return "Unknown error";
    }
  }

  /** Basic auth header + trailing-slash base URL for WebDAV. */
  function webdavBase(config: SyncConfig): { authHeader: string; baseUrl: string } {
    const pass = resolveSecret(config.webdavPass);
    const authHeader = `Basic ${Buffer.from(`${config.webdavUser}:${pass}`).toString("base64")}`;
    let baseUrl = config.webdavUrl;
    if (!baseUrl.endsWith("/")) baseUrl += "/";
    return { authHeader, baseUrl };
  }

  function isBackendConfigured(config: SyncConfig): boolean {
    if (config.backend === "s3") {
      return Boolean(config.s3Bucket && config.s3AccessKeyId && config.s3SecretAccessKey);
    }
    return Boolean(config.webdavUrl && config.webdavUser && config.webdavPass);
  }

  function backendLabel(config: SyncConfig): string {
    if (config.backend === "s3") {
      const ep = config.s3Endpoint ? ` @ ${config.s3Endpoint}` : "";
      return `S3 s3://${config.s3Bucket}/${config.s3Prefix}${ep}`;
    }
    return `WebDAV ${config.webdavUrl || "(not set)"}`;
  }

// Thin wrapper: run tar via shared runCommand, preserving throw-on-error semantics
  async function runTar(args: string[], options: { capture?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const r = await runCommand("tar", args, { timeoutMs: options.timeoutMs ?? TAR_TIMEOUT_MS });
    if (!r.ok) throw new Error(r.stderr || `tar ${args[0]} failed with status ${r.status}`);
    return options.capture ? r.stdout : "";
  }

  /** Fail fast if tar cannot create/list gzip archives (cross-platform .tar.gz). */
  async function ensureTarAvailable(): Promise<void> {
    const version = await runCommand("tar", ["--version"], { timeoutMs: 10_000 });
    if (!version.ok) {
      throw new Error(
        "tar is not available on PATH. Install system tar (Windows 10+ built-in, Git for Windows, or WSL/GNU tar) and retry.",
      );
    }

    const probeDir = path.join(os.tmpdir(), `pi_sync_tar_probe_${Date.now()}`);
    const probeArc = path.join(os.tmpdir(), `pi_sync_tar_probe_${Date.now()}.tar.gz`);
    try {
      fs.mkdirSync(probeDir, { recursive: true });
      fs.writeFileSync(path.join(probeDir, "probe.txt"), "ok", "utf-8");
      const created = await runCommand(
        "tar",
        ["-c", "-z", "-f", probeArc, "-C", probeDir, "."],
        { timeoutMs: 30_000 },
      );
      if (!created.ok || !fs.existsSync(probeArc)) {
        throw new Error(
          "tar cannot create .tar.gz archives (`tar -czf`). " +
            "Install GNU tar or Windows 10+ bsdtar. " +
            (created.stderr || ""),
        );
      }
      const listed = await runCommand(
        "tar",
        ["-t", "-z", "-f", probeArc],
        { timeoutMs: 30_000 },
      );
      if (!listed.ok) {
        throw new Error(
          "tar cannot list .tar.gz archives (`tar -tzf`). " + (listed.stderr || ""),
        );
      }
    } finally {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { if (fs.existsSync(probeArc)) fs.unlinkSync(probeArc); } catch { /* ignore */ }
    }
  }

  function isGzipArchive(filePath: string): boolean {
    return /\.(tar\.gz|tgz)$/i.test(filePath);
  }

  function isZipArchive(filePath: string): boolean {
    return /\.zip$/i.test(filePath);
  }

  /** Detect real ZIP by magic bytes (PK\x03\x04), not only by extension. */
  function looksLikeZipFile(filePath: string): boolean {
    return isZipArchive(filePath) || isZipFile(filePath);
  }

  /** List archive members (.tar.gz preferred; legacy .zip via pure-JS reader). */
  async function listArchiveEntries(archivePath: string): Promise<string[]> {
    // Prefer magic-byte ZIP detection: Windows backups are real zips even if
    // some tools rename them; GNU tar cannot list them.
    if (looksLikeZipFile(archivePath)) {
      try {
        return listZipEntries(archivePath).map((e) => normalizeArchiveEntry(e)).filter(Boolean);
      } catch (e) {
        // fall through to tar attempts
        const zipErr = formatError(e);
        const tryArgs: string[][] = [
          ["-t", "-a", "-f", archivePath],
          ["-t", "-f", archivePath],
        ];
        for (const args of tryArgs) {
          const listed = await runCommand("tar", args, { timeoutMs: TAR_TIMEOUT_MS });
          if (listed.ok) {
            return listed.stdout
              .split(/\r?\n/)
              .map((line) => normalizeArchiveEntry(line.trim()))
              .filter((entry) => entry.length > 0);
          }
        }
        throw new Error(
          `Failed to list ZIP backup: ${zipErr}. ` +
            "On Linux, pi-sync ≥ v1.3.7 extracts ZIP in pure JS; if this persists, re-upload as .tar.gz from the source PC.",
        );
      }
    }

    if (isGzipArchive(archivePath)) {
      const listed = await runCommand("tar", ["-t", "-z", "-f", archivePath], { timeoutMs: TAR_TIMEOUT_MS });
      if (!listed.ok) {
        throw new Error(listed.stderr || `Failed to list .tar.gz: ${archivePath}`);
      }
      return listed.stdout
        .split(/\r?\n/)
        .map((line) => normalizeArchiveEntry(line.trim()))
        .filter((entry) => entry.length > 0);
    }

    const listed = await runCommand("tar", ["-t", "-f", archivePath], { timeoutMs: TAR_TIMEOUT_MS });
    if (!listed.ok) {
      // Last resort: maybe misnamed zip
      if (isZipFile(archivePath)) {
        return listZipEntries(archivePath).map((e) => normalizeArchiveEntry(e)).filter(Boolean);
      }
      throw new Error(listed.stderr || `Failed to list archive: ${archivePath}`);
    }
    return listed.stdout
      .split(/\r?\n/)
      .map((line) => normalizeArchiveEntry(line.trim()))
      .filter((entry) => entry.length > 0);
  }

  /** Extract archive into destDir. ZIP uses pure Node (no GNU tar zip support needed). */
  async function extractArchiveTo(archivePath: string, destDir: string): Promise<void> {
    if (looksLikeZipFile(archivePath)) {
      try {
        extractZipToDir(archivePath, destDir);
        return;
      } catch (zipErr) {
        // Security rejections (path traversal) must never fall back to an
        // external extractor — that would bypass the rejection.
        if (isZipSecurityError(zipErr)) throw zipErr;
        // Optional fallbacks if pure-JS fails (encrypted/unsupported method)
        const attempts: Array<{ cmd: string; args: string[] }> = [
          { cmd: "unzip", args: ["-o", archivePath, "-d", destDir] },
          { cmd: "tar", args: ["-x", "-a", "-f", archivePath, "-C", destDir] },
        ];
        for (const a of attempts) {
          const r = await runCommand(a.cmd, a.args, { timeoutMs: TAR_TIMEOUT_MS });
          if (r.ok) return;
        }
        if (process.platform === "win32") {
          const ps = await runCommand(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
            ],
            { timeoutMs: TAR_TIMEOUT_MS },
          );
          if (ps.ok) return;
        }
        throw new Error(
          `Cannot extract ZIP backup: ${formatError(zipErr)}. ` +
            "Re-upload from Windows with pi-sync ≥ v1.3.6 as .tar.gz for best compatibility.",
        );
      }
    }

    if (isGzipArchive(archivePath)) {
      await runTar(["-x", "-z", "-f", archivePath, "-C", destDir]);
      return;
    }

    // Unknown extension: try gzip tar, then zip magic
    const tarTry = await runCommand("tar", ["-x", "-z", "-f", archivePath, "-C", destDir], { timeoutMs: TAR_TIMEOUT_MS });
    if (tarTry.ok) return;
    if (isZipFile(archivePath)) {
      extractZipToDir(archivePath, destDir);
      return;
    }
    await runTar(["-x", "-f", archivePath, "-C", destDir]);
  }


  function readSettingsPackages(): string[] {
    const settingsPath = path.join(getAgentDir(), "settings.json");
    const data = readJsonSafe<{ packages?: unknown[] }>(settingsPath, {});
    if (!Array.isArray(data.packages)) return [];
    // Packages may be strings or { source, … } objects — normalize for diffing.
    return data.packages.map((p) => {
      if (typeof p === "string") return p;
      if (p !== null && typeof p === "object" && typeof (p as { source?: unknown }).source === "string") {
        return (p as { source: string }).source;
      }
      return JSON.stringify(p);
    });
  }

  function diffStringLists(before: string[], after: string[]): { added: string[]; removed: string[] } {
    const b = new Set(before);
    const a = new Set(after);
    return {
      added: after.filter((x) => !b.has(x)),
      removed: before.filter((x) => !a.has(x)),
    };
  }

  function formatRestoreReport(opts: {
    backupName: string;
    restored: string[];
    safetyBackups: string[];
    packagesBefore: string[];
    packagesAfter: string[];
    portabilityLines: string[];
  }): string {
    const lines: string[] = [];
    lines.push(`Backup: ${opts.backupName}`);
    lines.push("── Restored ──");
    if (opts.restored.length === 0) lines.push("  (nothing restored — check sync include toggles)");
    else for (const r of opts.restored) lines.push(`  • ${r}`);

    lines.push("── Local safety backups ──");
    if (opts.safetyBackups.length === 0) lines.push("  (none created)");
    else for (const p of opts.safetyBackups) lines.push(`  • ${p}`);

    const pkgDiff = diffStringLists(opts.packagesBefore, opts.packagesAfter);
    lines.push("── settings.packages ──");
    if (pkgDiff.added.length === 0 && pkgDiff.removed.length === 0) {
      lines.push("  (unchanged)");
    } else {
      for (const x of pkgDiff.added) lines.push(`  + ${x}`);
      for (const x of pkgDiff.removed) lines.push(`  - ${x}`);
    }

    if (opts.portabilityLines.length > 0) {
      lines.push("── Path portability ──");
      for (const l of opts.portabilityLines) lines.push(`  ${l}`);
    }

    lines.push("── Next ──");
    lines.push("  Reload runtime (or restart Pi) to apply skills/extensions/packages.");
    lines.push("  Device-local providers (127.0.0.1) and provider-proxy ports may need this machine.");
    return lines.join("\n");
  }

  function normalizeArchiveEntry(entry: string): string {
    // tar -t may emit "./config/...", ".", or Windows backslashes.
    let e = entry.replace(/\\/g, "/").trim();
    while (e === "." || e.startsWith("./")) {
      e = e === "." ? "" : e.slice(2);
    }
    e = e.replace(/^\.(\/|$)/, "");
    return e.replace(/\/$/, "");
  }


  // ── Staged restore: inspect → preview → apply ─────────────────────

  interface StagedConfigFile {
    name: string;
    /** True when the file parsed as JSON. */
    isJson: boolean;
    /** Parsed JSON value (as-is). */
    parsed: unknown;
    /** Rebased value (differs from parsed only when rebases exist). */
    value: unknown;
    rebases: PathRebase[];
    warnings: PortabilityWarning[];
  }

  interface StagedAgentConfigFile {
    /** Path inside the archive, e.g. agent-config/agent/AGENTS.md. */
    archive: string;
    /** Staged absolute path. */
    srcPath: string;
    /** Where it restores: "pi-home" (~/.pi) or "agent-dir". */
    destKind: "pi-home" | "agent-dir";
    /** File path under the destination root. */
    file: string;
  }

  interface StagedRestore {
    stageDir: string;
    /** null = legacy archive without manifest (verbatim restore). */
    manifest: SyncManifest | null;
    /** Authorized config files (core + this profile's allowlist). */
    configFiles: StagedConfigFile[];
    /** Config files found in the archive but NOT authorized here. */
    skippedConfigFiles: string[];
    agentConfigFiles: StagedAgentConfigFile[];
    hasSkills: boolean;
    hasExtensions: boolean;
    entries: string[];
  }

  /**
   * Pre-extraction validation: tar members must be plain files or directories.
   * Symlink/hardlink/device/fifo members are rejected BEFORE extraction, so a
   * crafted archive cannot write through links while being extracted.
   * Listing failures (e.g. GNU tar on zip) are skipped — the pure-JS zip
   * extractor writes regular files only, and assertNoSymlinks runs after.
   */
  async function assertArchiveMembersArePlain(archivePath: string): Promise<void> {
    const attempts: string[][] = isGzipArchive(archivePath)
      ? [["-t", "-v", "-z", "-f", archivePath]]
      : [
          ["-t", "-v", "-a", "-f", archivePath], // bsdtar auto-detects (incl. zip)
          ["-t", "-v", "-f", archivePath], // plain tar
        ];
    for (const args of attempts) {
      const r = await runCommand("tar", args, { timeoutMs: TAR_TIMEOUT_MS });
      if (!r.ok) continue; // try next / skip validation
      for (const line of r.stdout.split(/\r?\n/)) {
        const token = line.trim().split(/\s+/)[0] || "";
        const type = token.charAt(0);
        if (!type) continue;
        if (type !== "-" && type !== "d") {
          throw new Error(
            `Archive member is not a plain file/directory (type "${type}"): ${line.trim().slice(0, 120)}`,
          );
        }
      }
      return;
    }
  }

  /** Destination file must not be a symlink: replace the link itself, never write through it. */
  function replaceIfSymlink(destFile: string): void {
    try {
      if (fs.lstatSync(destFile).isSymbolicLink()) fs.unlinkSync(destFile);
    } catch {
      // does not exist — fine
    }
  }

  /** Destination directory must not be a symlink (suspicious state — abort). */
  function assertDirNotSymlink(dir: string, label: string): void {
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return; // does not exist — fine
    }
    if (st.isSymbolicLink()) {
      throw new Error(`${label} destination is a symbolic link: ${dir} — restore aborted; inspect your agent dir`);
    }
  }

  /** Reject symbolic links anywhere in the staged tree (tar members can carry them). */
  function assertNoSymlinks(dir: string): void {
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) break;
      for (const name of fs.readdirSync(cur)) {
        const p = path.join(cur, name);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) {
          throw new Error(`Archive contains a symbolic link; rejected: ${path.relative(dir, p)}`);
        }
        if (st.isDirectory()) stack.push(p);
      }
    }
  }

  /** Report-only scan for legacy archives (no manifest): loopback URLs + home-ish absolute paths. */
  function scanLegacyWarnings(fileName: string, obj: unknown): PortabilityWarning[] {
    const warnings: PortabilityWarning[] = [];
    const HOME_ISH_RE = /^(\/home\/[^/]+\/|\/Users\/[^/]+\/|[A-Za-z]:[\\\/]Users[\\\/])/;
    const walk = (node: unknown, prefix: string, depth: number): void => {
      if (depth > 12 || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${prefix}[${i}]`, depth + 1));
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const field = `${fileName}:${prefix}${prefix ? "." : ""}${k}`;
        if (typeof v === "string") {
          const cls = classifyUrl(v);
          if (cls === "loopback" || cls === "private") {
            warnings.push({
              field,
              value: v,
              kind: cls === "loopback" ? "loopback-url" : "private-url",
              hint: "device/LAN-local URL — may need a local service on this machine",
            });
          } else if (HOME_ISH_RE.test(v)) {
            warnings.push({
              field,
              value: redactValue(v),
              kind: "unrebased-path",
              hint: "legacy archive: absolute home path restored as-is",
            });
          }
        } else if (v !== null && typeof v === "object") {
          walk(v, `${prefix}${prefix ? "." : ""}${k}`, depth + 1);
        }
      }
    };
    walk(obj, "", 0);
    return warnings;
  }

  /**
   * Extract the archive into a staging dir, validate it, read the manifest,
   * and compute path rebases — WITHOUT touching the agent dir.
   * The confirm dialog then previews exactly what will be applied.
   *
   * Config files are filtered to what THIS profile authorizes (core files +
   * its extra-config allowlist); anything else in the archive is reported as
   * skipped and never restored.
   */
  async function stageRestore(archivePath: string, config: SyncConfig): Promise<StagedRestore> {
    const stageDir = path.join(os.tmpdir(), `pi_sync_stage_${Date.now()}`);
    fs.mkdirSync(stageDir, { recursive: true });
    try {
      const entries = await listArchiveEntries(archivePath);
      validateArchiveEntries(entries);
      // Validate member types BEFORE extraction so links cannot be followed
      // while extracting. (Also re-checked on the staged tree afterwards.)
      await assertArchiveMembersArePlain(archivePath);
      await extractArchiveTo(archivePath, stageDir);
      assertNoSymlinks(stageDir);

      // Manifest (optional: legacy archives have none)
      const manifestPath = path.join(stageDir, "manifest.json");
      let manifest: SyncManifest | null = null;
      if (fs.existsSync(manifestPath)) {
        let raw: unknown;
        try {
          raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        } catch (e) {
          throw new Error(`manifest.json is not valid JSON: ${formatError(e)}`);
        }
        manifest = parseManifest(raw); // throws on malformed/unsupported
      }

      const ctx = manifest
        ? rebaseContextFromManifest(manifest, os.homedir(), getAgentDir(), (p) => {
            try {
              return fs.existsSync(p);
            } catch {
              return false;
            }
          })
        : null;

      // ── Agent-config files (exact whitelist from archive-rules) ──
      const agentConfigFiles: StagedAgentConfigFile[] = [];
      let legacyMcpConsumed = false;
      for (const spec of AGENT_CONFIG_FILES) {
        const srcPath = path.join(stageDir, ...spec.archive.split("/"));
        if (!fs.existsSync(srcPath)) continue;
        // Legacy layout: mcp.json under agent-config/. Prefer config/mcp.json
        // when the archive also has it; otherwise consume it as the mcp.json
        // config file (subject to the same authorization rules).
        if (spec.file === "mcp.json" && spec.archive !== "config/mcp.json") {
          const modernMcp = path.join(stageDir, "config", "mcp.json");
          if (fs.existsSync(modernMcp)) continue; // modern copy wins
          agentConfigFiles.push({ archive: spec.archive, srcPath, destKind: spec.dest, file: spec.file });
          legacyMcpConsumed = true;
          continue;
        }
        agentConfigFiles.push({ archive: spec.archive, srcPath, destKind: spec.dest, file: spec.file });
      }

      // ── Config files: authorized set only ──
      const authorized = new Set<string>([...CORE_CONFIG_FILES, ...config.extraConfigFiles]);
      if (legacyMcpConsumed) authorized.add("mcp.json");
      const configFiles: StagedConfigFile[] = [];
      const skippedConfigFiles: string[] = [];
      const configSrc = path.join(stageDir, "config");
      if (fs.existsSync(configSrc)) {
        for (const name of fs.readdirSync(configSrc).sort()) {
          const src = path.join(configSrc, name);
          if (!fs.statSync(src).isFile()) continue;
          if (!authorized.has(name)) {
            skippedConfigFiles.push(name);
            continue;
          }
          let parsed: unknown = undefined;
          let isJson = false;
          try {
            parsed = JSON.parse(fs.readFileSync(src, "utf-8"));
            isJson = true;
          } catch {
            // not JSON — restored verbatim
          }
          let value = parsed;
          let rebases: PathRebase[] = [];
          let warnings: PortabilityWarning[] = [];
          if (isJson && ctx) {
            const r = rebaseConfigFile(name, parsed, ctx);
            value = r.value;
            rebases = r.rebases;
            warnings = r.warnings;
          } else if (isJson) {
            warnings = scanLegacyWarnings(name, parsed);
          }
          configFiles.push({ name, isJson, parsed, value, rebases, warnings });
        }
      }

      return {
        stageDir,
        manifest,
        configFiles,
        skippedConfigFiles,
        agentConfigFiles,
        hasSkills: fs.existsSync(path.join(stageDir, "skills")),
        hasExtensions: fs.existsSync(path.join(stageDir, "extensions")),
        entries,
      };
    } catch (e) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw e;
    }
  }

  /** Human-readable preview lines for the confirm dialog (and the report). */
  function buildRestorePreview(staged: StagedRestore, config: SyncConfig): string[] {
    const lines: string[] = [];
    const cfgNames = staged.configFiles.map((f) => f.name);
    if (cfgNames.length > 0 || config.backupProviders) {
      lines.push(
        config.backupProviders
          ? `Config files to restore (${cfgNames.length}): ${cfgNames.join(", ") || "—"}`
          : `Config files present but skipped by settings (${cfgNames.join(", ") || "—"})`,
      );
    }
    if (staged.hasSkills) {
      lines.push(config.backupSkills ? "Skills directory will be replaced; current skills get a timestamped backup folder." : "Skills are present but skipped by current settings.");
    }
    if (staged.hasExtensions) {
      lines.push(config.backupExtensions ? "Extensions will be merged/overwritten; current extensions get a timestamped backup folder." : "Extensions are present but skipped by current settings.");
    }

    if (staged.agentConfigFiles.length > 0) {
      const names = staged.agentConfigFiles.map((f) => f.file).join(", ");
      lines.push(
        config.backupAgentConfig
          ? `Agent config files to restore: ${names}`
          : `Agent config present but skipped by settings (${names})`,
      );
    }
    if (staged.skippedConfigFiles.length > 0) {
      lines.push(`Skipped (not authorized on this profile): ${staged.skippedConfigFiles.join(", ")}`);
    }

    lines.push("── Path portability ──");
    if (!staged.manifest) {
      lines.push("⚠ Legacy archive (no manifest): paths restored verbatim — review config paths manually.");
    } else {
      const src = staged.manifest.source;
      lines.push(`Source: ${src.platformTag} · home ${src.home}`);
      const rebases = staged.configFiles.flatMap((f) => f.rebases);
      if (rebases.length === 0) {
        lines.push("No paths need rebasing.");
      } else {
        lines.push(`Paths rebased to this machine (${rebases.length}):`);
        for (const r of rebases.slice(0, 15)) {
          lines.push(`  • ${r.field}: ${r.from} → ${r.to}${r.exists ? "" : "  (missing here)"}`);
        }
        if (rebases.length > 15) lines.push(`  … +${rebases.length - 15} more`);
      }
    }

    const warnings = staged.configFiles.flatMap((f) => f.warnings);
    if (warnings.length > 0) {
      lines.push(`Warnings (${warnings.length}):`);
      for (const w of warnings.slice(0, 15)) {
        lines.push(`  • ${w.field}: ${w.value} — ${w.hint}`);
      }
      if (warnings.length > 15) lines.push(`  … +${warnings.length - 15} more`);
    }

    if (lines.length === 0) {
      lines.push("No restorable config, skills, or extensions found in this archive.");
    }
    return lines;
  }

  /** Apply the exact staged (and previewed) result into the agent dir. */
  async function applyStagedRestore(
    staged: StagedRestore,
    config: SyncConfig,
  ): Promise<{ restored: string[]; safetyBackups: string[] }> {
    const agentDir = getAgentDir();
    const restored: string[] = [];
    const safetyBackups: string[] = [];

    if (staged.configFiles.length > 0 && config.backupProviders) {
      for (const f of staged.configFiles) {
        const destFile = path.join(agentDir, f.name);
        // A planted symlink would make the copy write elsewhere — replace it.
        replaceIfSymlink(destFile);
        if (fs.existsSync(destFile)) {
          const bakPath = `${destFile}.bak-${timestampForBackup()}`;
          fs.copyFileSync(destFile, bakPath);
          safetyBackups.push(bakPath);
        }
        if (f.isJson && f.rebases.length > 0) {
          // Write the rebased JSON exactly as previewed.
          fs.writeFileSync(destFile, JSON.stringify(f.value, null, 2) + "\n", "utf-8");
        } else {
          fs.copyFileSync(path.join(staged.stageDir, "config", f.name), destFile);
        }
        restored.push(`Config: ${f.name}`);
      }
    }

    // Agent-config files (web-search.json → ~/.pi, others → agent dir).
    if (staged.agentConfigFiles.length > 0 && config.backupAgentConfig) {
      const piHome = path.join(os.homedir(), ".pi");
      for (const f of staged.agentConfigFiles) {
        const destRoot = f.destKind === "pi-home" ? piHome : agentDir;
        const destFile = path.join(destRoot, ...f.file.split("/"));
        replaceIfSymlink(destFile);
        if (fs.existsSync(destFile)) {
          const bakPath = `${destFile}.bak-${timestampForBackup()}`;
          fs.copyFileSync(destFile, bakPath);
          safetyBackups.push(bakPath);
        }
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(f.srcPath, destFile);
        restored.push(`Agent Config: ${f.file}`);
      }
      await yieldToUI();
    }

    const skillsSrc = path.join(staged.stageDir, "skills");
    if (staged.hasSkills && config.backupSkills) {
      const skillsDest = path.join(agentDir, "skills");
      assertDirNotSymlink(skillsDest, "skills");
      const skillsBackup = path.join(agentDir, `skills-backup-${timestampForBackup()}`);
      if (fs.existsSync(skillsDest)) {
        fs.renameSync(skillsDest, skillsBackup);
        safetyBackups.push(skillsBackup);
      }

      fs.mkdirSync(skillsDest, { recursive: true });
      copyRecursiveSync(skillsSrc, skillsDest);
      await yieldToUI();
      restored.push(`Skills directory`);
    }

    const extSrc = path.join(staged.stageDir, "extensions");
    if (staged.hasExtensions && config.backupExtensions) {
      const extDest = path.join(agentDir, "extensions");
      assertDirNotSymlink(extDest, "extensions");
      const extBackup = path.join(agentDir, `extensions-backup-${timestampForBackup()}`);
      if (fs.existsSync(extDest)) {
        fs.mkdirSync(extBackup, { recursive: true });
        copyRecursiveSync(extDest, extBackup);
        safetyBackups.push(extBackup);
      }

      copyRecursiveSync(extSrc, extDest);
      await yieldToUI();
      restored.push(`Extensions directory (merged)`);
    }

    return { restored, safetyBackups };
  }

  // ── Cloud backends ──────────────────────────────────────────────────

  async function listCloudBackups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
    if (config.backend === "s3") return listS3Backups(config, ctx);
    return listWebdavBackups(config, ctx);
  }

  async function uploadToCloud(filePath: string, config: SyncConfig, ctx: ExtensionCommandContext): Promise<void> {
    if (config.backend === "s3") return uploadToS3(filePath, config, ctx);
    return uploadToWebdav(filePath, config, ctx);
  }

  async function downloadFromCloud(filename: string, destPath: string, config: SyncConfig, ctx: ExtensionCommandContext): Promise<void> {
    if (config.backend === "s3") return downloadFromS3(filename, destPath, config, ctx);
    return downloadFromWebdav(filename, destPath, config, ctx);
  }

  // ── WebDAV ──────────────────────────────────────────────────────────

  function isBackupArchiveName(name: string): boolean {
    if (!name.startsWith("pi_sync_backup_")) return false;
    return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".zip");
  }

  /** Collect pi_sync_backup_*.{tar.gz,zip} names from a WebDAV PROPFIND XML body. */
  function parseWebdavBackupNames(xml: string): string[] {
    const backups: string[] = [];
    const displayRe = /<[a-zA-Z0-9:-]*displayname>([^<]+)<\/[a-zA-Z0-9:-]*displayname>/g;
    let match: RegExpExecArray | null;
    while ((match = displayRe.exec(xml)) !== null) {
      const name = match[1].trim();
      if (isBackupArchiveName(name) && !backups.includes(name)) backups.push(name);
    }
    if (backups.length === 0) {
      const hrefRe = /<[a-zA-Z0-9:-]*href>([^<]+)<\/[a-zA-Z0-9:-]*href>/g;
      while ((match = hrefRe.exec(xml)) !== null) {
        const filename = path.basename(decodeURIComponent(match[1].trim()));
        if (isBackupArchiveName(filename) && !backups.includes(filename)) backups.push(filename);
      }
    }
    return sortBackupNamesNewestFirst(backups);
  }

  async function listWebdavBackups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
    const { authHeader, baseUrl: url } = webdavBase(config);

    try {
      const response = await fetchWithTimeout(url, {
        method: "PROPFIND",
        headers: {
          Authorization: authHeader,
          Depth: "1",
          "Content-Type": "application/xml",
        },
      }, CLOUD_FETCH_TIMEOUT_MS, ctx.signal);

      if (!response.ok) {
        throw new Error(`WebDAV returns HTTP ${response.status}: ${response.statusText}`);
      }

      return parseWebdavBackupNames(await response.text());
    } catch (e) {
      throw new Error(`Failed to query cloud backups: ${formatError(e)}`);
    }
  }

  async function uploadToWebdav(filePath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const filename = path.basename(filePath);
    const { authHeader, baseUrl } = webdavBase(config);
    const url = baseUrl + encodeURIComponent(filename);

    const fileBuffer = fs.readFileSync(filePath);
    const response = await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/octet-stream",
      },
      body: fileBuffer,
    }, CLOUD_FETCH_TIMEOUT_MS, ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV PUT returns HTTP ${response.status}: ${response.statusText}`);
    }
  }

  async function downloadFromWebdav(filename: string, destPath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const { authHeader, baseUrl } = webdavBase(config);
    const url = baseUrl + encodeURIComponent(filename);

    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: authHeader },
    }, CLOUD_FETCH_TIMEOUT_MS, ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV GET returns HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  }

  // ── S3 ──────────────────────────────────────────────────────────────

  function s3Creds(config: SyncConfig) {
    return {
      accessKeyId: resolveSecret(config.s3AccessKeyId),
      secretAccessKey: resolveSecret(config.s3SecretAccessKey),
      sessionToken: config.s3SessionToken ? resolveSecret(config.s3SessionToken) : undefined,
      region: config.s3Region || "us-east-1",
      bucket: config.s3Bucket,
      endpoint: config.s3Endpoint || undefined,
      forcePathStyle: config.s3Endpoint ? config.s3ForcePathStyle !== false : config.s3ForcePathStyle === true,
      prefix: normalizePrefix(config.s3Prefix),
    };
  }

  function objectKeyForBackup(config: SyncConfig, filename: string): string {
    const prefix = normalizePrefix(config.s3Prefix);
    const base = path.basename(filename);
    return `${prefix}${base}`;
  }

  /** SigV4 clock skew (ms); learned from server Date / RequestTimeTooSkewed. */
  let s3ClockSkewMs = 0;
  let s3ClockSkewProbed = false;

  function resetS3ClockSkew(): void {
    s3ClockSkewMs = 0;
    s3ClockSkewProbed = false;
  }

  function s3Now(): Date {
    return new Date(Date.now() + s3ClockSkewMs);
  }

  function learnSkewFromResponse(resp: Response): void {
    const dateHdr = resp.headers.get("date");
    if (!dateHdr) return;
    const serverMs = Date.parse(dateHdr);
    if (!Number.isFinite(serverMs)) return;
    s3ClockSkewMs = serverMs - Date.now();
    s3ClockSkewProbed = true;
  }

  function isRequestTimeTooSkewed(status: number, body: string): boolean {
    if (status !== 403 && status !== 400) return false;
    return /RequestTimeTooSkewed|request time/i.test(body);
  }

  async function ensureS3ClockSkew(config: SyncConfig, signal?: AbortSignal): Promise<void> {
    if (s3ClockSkewProbed) return;
    const creds = s3Creds(config);
    // Cheap unauthenticated probe against the endpoint (or AWS regional host).
    const probeUrl = creds.endpoint
      ? creds.endpoint.replace(/\/$/, "") + "/"
      : `https://s3.${creds.region}.amazonaws.com/`;
    try {
      const resp = await fetchWithTimeout(probeUrl, { method: "GET" }, 15_000, signal);
      learnSkewFromResponse(resp);
    } catch {
      // ignore — will still try signed requests with local clock
    } finally {
      s3ClockSkewProbed = true;
    }
  }

  async function s3SignedFetch(
    config: SyncConfig,
    opts: {
      method: string;
      key: string;
      query?: Record<string, string>;
      body?: Buffer;
      contentType?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    await ensureS3ClockSkew(config, opts.signal);

    const creds = s3Creds(config);
    const payloadHash = opts.body ? sha256Hex(opts.body) : sha256Hex("");
    const built = buildS3Url({
      bucket: creds.bucket,
      region: creds.region,
      key: opts.key,
      endpoint: creds.endpoint,
      forcePathStyle: creds.forcePathStyle,
      query: opts.query,
    });

    const buildHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = { host: built.host };
      if (opts.contentType) headers["content-type"] = opts.contentType;
      if (opts.body) headers["content-length"] = String(opts.body.byteLength);
      return headers;
    };

    const doSigned = async (): Promise<Response> => {
      const signed = signAwsV4({
        method: opts.method,
        canonicalUri: built.canonicalUri,
        canonicalQuerystring: built.canonicalQuerystring,
        headers: buildHeaders(),
        payloadHash,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        region: creds.region,
        service: "s3",
        date: s3Now(),
      });
      return fetchWithTimeout(built.url, {
        method: opts.method,
        headers: signed.headers,
        body: opts.body,
      }, CLOUD_FETCH_TIMEOUT_MS, opts.signal);
    };

    let response = await doSigned();
    learnSkewFromResponse(response);

    if (!response.ok) {
      // Clone body for skew detection without consuming the returned body stream.
      const errText = await response.clone().text().catch(() => "");
      if (isRequestTimeTooSkewed(response.status, errText)) {
        // Force re-learn from this response and retry once with corrected clock.
        s3ClockSkewProbed = true;
        response = await doSigned();
        learnSkewFromResponse(response);
      }
    }

    return response;
  }

  async function listS3Backups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
    const creds = s3Creds(config);
    const prefix = creds.prefix;
    try {
      const response = await s3SignedFetch(config, {
        method: "GET",
        key: "",
        query: {
          "list-type": "2",
          prefix,
          "max-keys": "1000",
        },
        signal: ctx.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`S3 ListObjectsV2 HTTP ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
      }

      const xml = await response.text();
      const keys = parseListObjectsV2Keys(xml);
      const names = keys
        .map((k) => {
          if (prefix && k.startsWith(prefix)) return k.slice(prefix.length);
          return path.posix.basename(k);
        })
        .filter((name) => isBackupArchiveName(name) && !name.includes("/"));

      return sortBackupNamesNewestFirst(Array.from(new Set(names)));
    } catch (e) {
      throw new Error(`Failed to list S3 backups: ${formatError(e)}`);
    }
  }

  async function uploadToS3(filePath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const filename = path.basename(filePath);
    const key = objectKeyForBackup(config, filename);
    const fileBuffer = fs.readFileSync(filePath);

    const response = await s3SignedFetch(config, {
      method: "PUT",
      key,
      body: fileBuffer,
      contentType: "application/gzip",
      signal: ctx.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`S3 PUT HTTP ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
  }

  async function downloadFromS3(filename: string, destPath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const key = objectKeyForBackup(config, filename);
    const response = await s3SignedFetch(config, {
      method: "GET",
      key,
      signal: ctx.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`S3 GET HTTP ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  }

  // ── Zip create / extract ────────────────────────────────────────────

  async function createZip(config: SyncConfig, tempZipPath: string): Promise<string[]> {
    const agentDir = getAgentDir();
    const tempDir = path.join(os.tmpdir(), `pi_sync_temp_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const contents: string[] = [];

    try {
      if (config.backupProviders) {
        const filesToBackup = [...CORE_CONFIG_FILES, ...config.extraConfigFiles];
        const confDir = path.join(tempDir, "config");
        fs.mkdirSync(confDir, { recursive: true });
        for (const file of filesToBackup) {
          const src = path.join(agentDir, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(confDir, file));
            contents.push(`Config: ${file}`);
          }
        }
      }

      if (config.backupSkills) {
        const skillsSrc = path.join(agentDir, "skills");
        if (fs.existsSync(skillsSrc)) {
          const skillsDest = path.join(tempDir, "skills");
          fs.mkdirSync(skillsDest, { recursive: true });
          copyRecursiveSync(skillsSrc, skillsDest);
          await yieldToUI();
          contents.push(`Skills Directory`);
        }
      }

      if (config.backupExtensions) {
        const extSrc = path.join(agentDir, "extensions");
        if (fs.existsSync(extSrc)) {
          const extDest = path.join(tempDir, "extensions");
          fs.mkdirSync(extDest, { recursive: true });
          copyRecursiveSync(extSrc, extDest);
          await yieldToUI();

          const syncInBackup = path.join(extDest, "sync");
          if (fs.existsSync(syncInBackup)) {
            fs.rmSync(syncInBackup, { recursive: true, force: true });
          }
          contents.push(`Extensions Directory`);
        }
      }

      // Agent-level config (archive dir agent-config/). mcp.json is packed
      // under config/ as a core file — not duplicated here.
      if (config.backupAgentConfig) {
        const piHome = path.join(os.homedir(), ".pi");
        const agentConfigFiles: Array<{ src: string; dest: string; label: string }> = [
          {
            src: path.join(piHome, "web-search.json"),
            dest: path.join(tempDir, "agent-config", "web-search.json"),
            label: "Agent Config: web-search.json",
          },
          {
            src: path.join(agentDir, "AGENTS.md"),
            dest: path.join(tempDir, "agent-config", "agent", "AGENTS.md"),
            label: "Agent Config: AGENTS.md",
          },
          {
            src: path.join(agentDir, "pi-blackhole", "pi-blackhole-config.json"),
            dest: path.join(tempDir, "agent-config", "agent", "pi-blackhole", "pi-blackhole-config.json"),
            label: "Agent Config: pi-blackhole-config.json",
          },
        ];
        let anyAgentConfig = false;
        for (const { src, dest, label } of agentConfigFiles) {
          if (!fs.existsSync(src)) continue;
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          contents.push(label);
          anyAgentConfig = true;
        }
        if (anyAgentConfig) await yieldToUI();
      }

      if (contents.length === 0) {
        throw new Error("No components selected or found to backup!");
      }

      // Manifest: source-machine identity for cross-system path rebasing.
      const manifest: SyncManifest = {
        version: 1,
        piSyncVersion: PI_SYNC_VERSION,
        createdAt: new Date().toISOString(),
        source: {
          platform: os.platform(),
          platformTag: platformTag(),
          home: os.homedir(),
          agentDir,
        },
      };
      fs.writeFileSync(
        path.join(tempDir, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf-8",
      );

      await yieldToUI();
      await runTar(["-c", "-z", "-f", tempZipPath, "-C", tempDir, "."]);
      return contents;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /** Copy trees without deep JS recursion (Node fs.cpSync, with iterative fallback). */
  function copyRecursiveSync(src: string, dest: string) {
    if (typeof fs.cpSync === "function") {
      fs.cpSync(src, dest, { recursive: true, force: true });
      return;
    }
    const stack: Array<{ from: string; to: string }> = [{ from: src, to: dest }];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) break;
      const { from, to } = cur;
      if (!fs.existsSync(from)) continue;
      const st = fs.statSync(from);
      if (st.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) {
          stack.push({ from: path.join(from, name), to: path.join(to, name) });
        }
      } else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  }

  // ── UI: setup / configure ───────────────────────────────────────────

  async function configureWebdavFields(ctx: ExtensionCommandContext, cfg: SyncConfig): Promise<boolean> {
    const url = await ctx.ui.input(
      "WebDAV server URL (e.g. https://dav.jianguoyun.com/dav/):",
      cfg.webdavUrl,
    );
    if (!url) return false;
    const user = await ctx.ui.input("WebDAV username/email:", cfg.webdavUser);
    if (!user) return false;
    const pass = await ctx.ui.input(
      "WebDAV password/token (prefer $ENV_VAR, e.g. $PI_WEBDAV_TOKEN):",
      cfg.webdavPass,
    );
    if (!pass) return false;
    cfg.webdavUrl = url.trim();
    cfg.webdavUser = user.trim();
    cfg.webdavPass = pass.trim();
    return true;
  }

  async function configureS3Fields(ctx: ExtensionCommandContext, cfg: SyncConfig): Promise<boolean> {
    const bucket = await ctx.ui.input("S3 bucket name:", cfg.s3Bucket);
    if (!bucket) return false;
    const region = await ctx.ui.input("S3 region (e.g. us-east-1, ap-northeast-1):", cfg.s3Region || "us-east-1");
    if (!region) return false;
    const accessKey = await ctx.ui.input("S3 access key id (prefer $ENV_VAR):", cfg.s3AccessKeyId);
    if (!accessKey) return false;
    const secretKey = await ctx.ui.input("S3 secret access key (prefer $ENV_VAR):", cfg.s3SecretAccessKey);
    if (!secretKey) return false;
    const endpoint = await ctx.ui.input(
      "Custom endpoint (optional — MinIO/R2/OSS; leave empty for AWS):",
      cfg.s3Endpoint,
    );
    const prefix = await ctx.ui.input("Object key prefix (e.g. pi-backups/):", cfg.s3Prefix || "pi-backups/");
    const session = await ctx.ui.input(
      "Session token (optional; temporary creds / $ENV_VAR):",
      cfg.s3SessionToken,
    );

    cfg.s3Bucket = bucket.trim();
    cfg.s3Region = region.trim();
    cfg.s3AccessKeyId = accessKey.trim();
    cfg.s3SecretAccessKey = secretKey.trim();
    cfg.s3Endpoint = (endpoint || "").trim();
    cfg.s3Prefix = normalizePrefix(prefix || "pi-backups/");
    cfg.s3SessionToken = (session || "").trim();
    // Path-style is the safer default for custom endpoints.
    cfg.s3ForcePathStyle = Boolean(cfg.s3Endpoint) || cfg.s3ForcePathStyle;
    return true;
  }

  async function showSetupWizard(ctx: ExtensionCommandContext): Promise<boolean> {
    const wizConfig = loadConfig();
    ctx.ui.notify("Cloud storage is not configured. Choose a backend.", "warning");

    const backendChoice = await enhancedSelect(ctx, "Sync backend", [
      "WebDAV  — TeraCLOUD / 坚果云 / Nextcloud / ownCloud",
      "S3      — Amazon S3 / MinIO / Cloudflare R2 / compatible",
      "❌ Cancel",
    ]);
    if (!backendChoice || backendChoice.includes("Cancel")) {
      ctx.ui.notify("Sync setup cancelled.", "info");
      return false;
    }

    if (backendChoice.startsWith("S3")) {
      wizConfig.backend = "s3";
      if (!await configureS3Fields(ctx, wizConfig)) {
        ctx.ui.notify("Sync setup cancelled.", "info");
        return false;
      }
    } else {
      wizConfig.backend = "webdav";
      if (!await configureWebdavFields(ctx, wizConfig)) {
        ctx.ui.notify("Sync setup cancelled.", "info");
        return false;
      }
    }

    saveConfig(wizConfig);
    ctx.ui.notify(`Sync configuration saved (${wizConfig.backend}).`, "info");
    return true;
  }

  async function showConfigureSettings(ctx: ExtensionCommandContext): Promise<void> {
    const cfgConfig = loadConfig();
    while (true) {
      const items: string[] = [
        `Profile: ${loadStore().activeProfile}${cfgConfig.name ? ` (${cfgConfig.name})` : ""}`,
        `Display name: ${cfgConfig.name || "(same as id)"}`,
        `Backend: ${cfgConfig.backend === "s3" ? "S3-compatible" : "WebDAV"}`,
      ];

      if (cfgConfig.backend === "webdav") {
        items.push(
          `WebDAV URL: ${cfgConfig.webdavUrl || "(not set)"}`,
          `WebDAV Username: ${cfgConfig.webdavUser || "(not set)"}`,
          `WebDAV Password/Token: ${cfgConfig.webdavPass ? "(set)" : "(not set)"}`,
        );
      } else {
        items.push(
          `S3 Bucket: ${cfgConfig.s3Bucket || "(not set)"}`,
          `S3 Region: ${cfgConfig.s3Region || "(not set)"}`,
          `S3 Access Key: ${cfgConfig.s3AccessKeyId ? "(set)" : "(not set)"}`,
          `S3 Secret Key: ${cfgConfig.s3SecretAccessKey ? "(set)" : "(not set)"}`,
          `S3 Session Token: ${cfgConfig.s3SessionToken ? "(set)" : "(not set)"}`,
          `S3 Endpoint: ${cfgConfig.s3Endpoint || "(AWS default)"}`,
          `S3 Prefix: ${cfgConfig.s3Prefix || "(none)"}`,
          `S3 Path-style: ${cfgConfig.s3ForcePathStyle ? "ON" : "OFF"}`,
        );
      }

      items.push(
        `Backup Providers & Config: ${cfgConfig.backupProviders ? "ON" : "OFF"}`,
        `Backup Skills: ${cfgConfig.backupSkills ? "ON" : "OFF"}`,
        `Backup Extensions: ${cfgConfig.backupExtensions ? "ON" : "OFF"}`,
        `Extra config files: ${cfgConfig.extraConfigFiles.length ? cfgConfig.extraConfigFiles.join(", ") : "(none)"}`,
        `Backup Agent Config: ${cfgConfig.backupAgentConfig ? "ON" : "OFF"}`,
        "───────────────",
        "s Save",
        "x Back",
      );

      const storeSnap = loadStore();
      const selected = await enhancedSelect(ctx, `Configure: ${storeSnap.activeProfile}`, items);
      if (!selected || selected === "x Back") return;
      if (selected === "s Save") {
        saveConfig(cfgConfig);
        ctx.ui.notify("Sync configuration updated successfully!", "info");
        return;
      }

      if (selected.startsWith("Display name:")) {
        const val = await ctx.ui.input("Display name for this profile:", cfgConfig.name || loadStore().activeProfile);
        if (val) cfgConfig.name = val.trim();
        continue;
      }
      if (selected.startsWith("Profile:")) {
        ctx.ui.notify("Use main menu → Switch / Manage Profiles to change active profile.", "info");
        continue;
      }
      if (selected.startsWith("Backend:")) {
        const pick = await enhancedSelect(ctx, "Select backend", [
          "WebDAV",
          "S3-compatible",
        ]);
        if (pick?.startsWith("S3")) cfgConfig.backend = "s3";
        else if (pick) cfgConfig.backend = "webdav";
        continue;
      }

      if (selected.startsWith("WebDAV URL:")) {
        const val = await ctx.ui.input("WebDAV URL:", cfgConfig.webdavUrl);
        if (val) cfgConfig.webdavUrl = val.trim();
        continue;
      }
      if (selected.startsWith("WebDAV Username:")) {
        const val = await ctx.ui.input("WebDAV Username:", cfgConfig.webdavUser);
        if (val) cfgConfig.webdavUser = val.trim();
        continue;
      }
      if (selected.startsWith("WebDAV Password/Token:")) {
        const val = await ctx.ui.input(
          "WebDAV Password/Token (prefer $ENV_VAR; plaintext is stored in sync_config.json):",
          cfgConfig.webdavPass,
        );
        if (val) cfgConfig.webdavPass = val.trim();
        continue;
      }

      if (selected.startsWith("S3 Bucket:")) {
        const val = await ctx.ui.input("S3 bucket:", cfgConfig.s3Bucket);
        if (val) cfgConfig.s3Bucket = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Region:")) {
        const val = await ctx.ui.input("S3 region:", cfgConfig.s3Region);
        if (val) cfgConfig.s3Region = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Access Key:")) {
        const val = await ctx.ui.input("S3 access key id ($ENV_VAR ok):", cfgConfig.s3AccessKeyId);
        if (val) cfgConfig.s3AccessKeyId = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Secret Key:")) {
        const val = await ctx.ui.input("S3 secret access key ($ENV_VAR ok):", cfgConfig.s3SecretAccessKey);
        if (val) cfgConfig.s3SecretAccessKey = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Session Token:")) {
        const val = await ctx.ui.input("S3 session token (optional, $ENV_VAR ok):", cfgConfig.s3SessionToken);
        if (val !== undefined && val !== null) cfgConfig.s3SessionToken = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Endpoint:")) {
        const val = await ctx.ui.input("Custom endpoint (empty = AWS):", cfgConfig.s3Endpoint);
        if (val !== undefined && val !== null) {
          cfgConfig.s3Endpoint = val.trim();
          if (cfgConfig.s3Endpoint) cfgConfig.s3ForcePathStyle = true;
        }
        continue;
      }
      if (selected.startsWith("S3 Prefix:")) {
        const val = await ctx.ui.input("Object key prefix:", cfgConfig.s3Prefix);
        if (val !== undefined && val !== null) cfgConfig.s3Prefix = normalizePrefix(val);
        continue;
      }
      if (selected.startsWith("S3 Path-style:")) {
        cfgConfig.s3ForcePathStyle = !cfgConfig.s3ForcePathStyle;
        continue;
      }

      if (selected.startsWith("Backup Providers & Config:")) { cfgConfig.backupProviders = !cfgConfig.backupProviders; continue; }
      if (selected.startsWith("Backup Skills:")) { cfgConfig.backupSkills = !cfgConfig.backupSkills; continue; }
      if (selected.startsWith("Backup Extensions:")) { cfgConfig.backupExtensions = !cfgConfig.backupExtensions; continue; }
      if (selected.startsWith("Extra config files:")) {
        await showExtraConfigEditor(ctx, cfgConfig);
        continue;
      }
      if (selected.startsWith("Backup Agent Config:")) { cfgConfig.backupAgentConfig = !cfgConfig.backupAgentConfig; continue; }
    }
  }

  /** Editor for the extra-config allowlist: discovered agent-root *.json + manual add. */
  async function showExtraConfigEditor(ctx: ExtensionCommandContext, cfg: SyncConfig): Promise<void> {
    while (true) {
      const selected = cfg.extraConfigFiles;
      let candidates: string[] = [];
      try {
        candidates = fs
          .readdirSync(getAgentDir())
          .filter((name) => {
            if (!name.endsWith(".json") || name.startsWith(".")) return false;
            if (name.includes(".bak-")) return false;
            if (RESERVED_CONFIG_FILES.has(name.toLowerCase())) return false;
            if ((CORE_CONFIG_FILES as string[]).includes(name)) return false;
            if (name === "models-store.json") return false; // cache, not config
            if (name === "mcp-auth.json") return false; // OAuth grants — manual opt-in only
            if (name === "auth.json") return false; // core, secret-bearing
            return true;
          })
          .sort();
      } catch {
        // agent dir unreadable — manual add still works
      }
      const unselected = candidates.filter((c) => !selected.includes(c));

      const items: string[] = [];
      if (selected.length > 0) {
        items.push("── Selected (will sync) ──");
        for (const f of selected) items.push(`✓ ${f}`);
      }
      if (unselected.length > 0) {
        items.push("── Discovered in agent dir ──");
        for (const f of unselected) items.push(`○ ${f}`);
      }
      items.push(
        "───────────────",
        "+ Add file name manually",
        "s Save",
        "x Cancel",
      );

      const choice = await enhancedSelect(
        ctx,
        `Extra config files (${selected.length} selected) — plugin configs to sync`,
        items,
        { fuzzy: true },
      );
      if (!choice || choice === "x Cancel") return;
      if (choice === "s Save") {
        saveConfig(cfg);
        ctx.ui.notify("Extra config files saved.", "info");
        return;
      }
      if (choice === "+ Add file name manually") {
        const val = await ctx.ui.input("Config file name (e.g. pi-fff.json):", "");
        if (val) {
          const name = path.basename(val.trim().replace(/\\/g, "/"));
          if (
            !SAFE_CONFIG_NAME_RE.test(name) ||
            RESERVED_CONFIG_FILES.has(name.toLowerCase()) ||
            (CORE_CONFIG_FILES as string[]).includes(name)
          ) {
            ctx.ui.notify(`"${name}" is reserved, core, or unsafe.`, "warning");
          } else if (!cfg.extraConfigFiles.includes(name)) {
            cfg.extraConfigFiles.push(name);
          }
        }
        continue;
      }
      if (choice.startsWith("✓ ")) {
        const name = choice.slice(2).trim();
        cfg.extraConfigFiles = cfg.extraConfigFiles.filter((f) => f !== name);
        continue;
      }
      if (choice.startsWith("○ ")) {
        const name = choice.slice(2).trim();
        if (!cfg.extraConfigFiles.includes(name)) cfg.extraConfigFiles.push(name);
        continue;
      }
    }
  }

  // ── Upload / Download ───────────────────────────────────────────────

  /** Interactive multi-select of ready profiles (toggle until Done). */
  async function pickProfilesForSync(
    ctx: ExtensionCommandContext,
    title: string,
    opts?: { requireReady?: boolean; preselectActive?: boolean },
  ): Promise<string[] | null> {
    const store = loadStore();
    const requireReady = opts?.requireReady !== false;
    const ids = listProfileIds(store).filter((id) => {
      const cfg = store.profiles[id];
      return cfg && (!requireReady || isBackendConfigured(cfg));
    });
    if (ids.length === 0) {
      ctx.ui.notify("No ready profiles. Configure at least one complete WebDAV/S3 profile.", "warning");
      return null;
    }

    const selected = new Set<string>();
    if (opts?.preselectActive !== false && ids.includes(store.activeProfile)) {
      selected.add(store.activeProfile);
    } else if (ids.length === 1) {
      selected.add(ids[0]);
    }

    while (true) {
      const lines = ids.map((id) => {
        const mark = selected.has(id) ? "[x]" : "[ ]";
        return `${mark} ${profileSummary(id, store.profiles[id], id === store.activeProfile)}`;
      });
      const choice = await enhancedSelect(ctx, title, [
        ...lines,
        "───────────────",
        "✓ Select all ready",
        "✗ Clear selection",
        `s Done (${selected.size} selected)`,
        "x Cancel",
      ], { fuzzy: true });
      if (!choice || choice === "x Cancel") return null;
      if (choice.startsWith("s Done")) {
        if (selected.size === 0) {
          ctx.ui.notify("Select at least one profile", "warning");
          continue;
        }
        return Array.from(selected);
      }
      if (choice.startsWith("✓ Select all")) {
        for (const id of ids) selected.add(id);
        continue;
      }
      if (choice.startsWith("✗ Clear")) {
        selected.clear();
        continue;
      }
      const id = matchProfileIdFromLine(choice.replace(/^\[[ x]\]\s*/, ""), ids) || matchProfileIdFromLine(choice, ids);
      if (id) {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
    }
  }

  /** Include flags for packing: OR across selected profiles so nothing wanted is dropped. */
  function mergeIncludeFlags(configs: SyncConfig[]): SyncConfig {
    const base = normalizeConfig(configs[0] || defaultConfig());
    return {
      ...base,
      backupProviders: configs.some((c) => c.backupProviders),
      backupSkills: configs.some((c) => c.backupSkills),
      backupExtensions: configs.some((c) => c.backupExtensions),
      extraConfigFiles: Array.from(new Set(configs.flatMap((c) => c.extraConfigFiles || []))),
      backupAgentConfig: configs.some((c) => c.backupAgentConfig),
    };
  }

  async function uploadZipToProfiles(
    ctx: ExtensionCommandContext,
    tempZipPath: string,
    profileIds: string[],
  ): Promise<{ ok: string[]; fail: Array<{ id: string; error: string }> }> {
    const store = loadStore();
    const ok: string[] = [];
    const fail: Array<{ id: string; error: string }> = [];
    for (const id of profileIds) {
      const cfg = store.profiles[id];
      if (!cfg || !isBackendConfigured(cfg)) {
        fail.push({ id, error: "not configured" });
        continue;
      }
      ctx.ui.notify(`Uploading → [${id}] ${backendLabel(cfg)}...`, "info");
      await yieldToUI();
      try {
        resetS3ClockSkew();
        await uploadToCloud(tempZipPath, cfg, ctx);
        ok.push(id);
      } catch (e) {
        fail.push({ id, error: formatError(e) });
      }
    }
    return { ok, fail };
  }

  async function showUploadBackup(ctx: ExtensionCommandContext, multi = false): Promise<void> {
    const store = loadStore();
    let profileIds: string[];

    if (multi) {
      const picked = await pickProfilesForSync(ctx, "Upload: select target profiles", {
        requireReady: true,
        preselectActive: true,
      });
      if (!picked) return;
      profileIds = picked;
    } else {
      const ulConfig = loadConfig();
      if (!isBackendConfigured(ulConfig)) {
        ctx.ui.notify("Active profile is not fully configured. Open Configure Active Profile or switch profile.", "error");
        return;
      }
      profileIds = [store.activeProfile];
    }

    const configs = profileIds.map((id) => store.profiles[id]).filter(Boolean) as SyncConfig[];
    const packConfig = mergeIncludeFlags(configs);

    try {
      await ensureTarAvailable();
    } catch (e) {
      ctx.ui.notify(`❌ ${formatError(e)}`, "error");
      return;
    }

    // Confirm only for multi-target uploads (single-target stays one-click like before).
    if (profileIds.length > 1) {
      const targets = profileIds.map((id) => `  • ${id} — ${backendLabel(store.profiles[id])}`).join("\n");
      const confirmed = await ctx.ui.confirm(
        "Upload to multiple profiles?",
        [
          `Profiles (${profileIds.length}):`,
          targets,
          "",
          `Include: config=${packConfig.backupProviders} skills=${packConfig.backupSkills} extensions=${packConfig.backupExtensions}`,
          "One zip will be packed once, then uploaded to each target.",
        ].join("\n"),
      );
      if (!confirmed) {
        ctx.ui.notify("Upload cancelled.", "info");
        return;
      }
    }

    ctx.ui.notify(
      profileIds.length > 1 ? "Preparing local files to pack (once)..." : "Preparing local files to pack...",
      "info",
    );
    await yieldToUI();
    const now = new Date();
    const timestamp = formatBackupTimestamp(now);
    const dateStr = formatBackupDate(now);
    const zipFilename = `pi_sync_backup_${dateStr}_${timestamp}_${platformTag()}.tar.gz`;
    const tempZipPath = path.join(os.tmpdir(), zipFilename);

    try {
      const packedContents = await createZip(packConfig, tempZipPath);
      await yieldToUI();
      ctx.ui.notify(`Packed items:\n${packedContents.join("\n")}`, "info");

      const { ok, fail } = await uploadZipToProfiles(ctx, tempZipPath, profileIds);
      const lines = [
        `Archive: ${zipFilename}`,
        `OK (${ok.length}/${profileIds.length}): ${ok.join(", ") || "—"}`,
      ];
      if (fail.length) {
        lines.push(`FAIL (${fail.length}):`);
        for (const f of fail) lines.push(`  • ${f.id}: ${f.error}`);
      }
      const allOk = fail.length === 0;
      const head =
        profileIds.length === 1
          ? (allOk ? "🎉 Backup uploaded successfully" : "⚠️ Upload finished with errors")
          : (allOk ? "🎉 Multi-profile upload finished" : "⚠️ Multi-profile upload finished with errors");
      ctx.ui.notify(`${head}\n${lines.join("\n")}`, allOk ? "info" : "warning");
    } catch (e) {
      ctx.ui.notify(`❌ Backup upload failed: ${formatError(e)}`, "error");
    } finally {
      if (fs.existsSync(tempZipPath)) {
        try { fs.unlinkSync(tempZipPath); } catch { /* ignore */ }
      }
    }
  }

  async function showDownloadBackup(ctx: ExtensionCommandContext): Promise<void> {
    const store = loadStore();
    let profileId = store.activeProfile;
    const readyIds = listProfileIds(store).filter((id) => isBackendConfigured(store.profiles[id]));

    // If several ready profiles exist, allow picking source without permanently switching active.
    if (readyIds.length > 1) {
      const pick = await enhancedSelect(ctx, "Download from profile", [
        ...readyIds.map((id) => profileSummary(id, store.profiles[id], id === store.activeProfile)),
        "x Cancel",
      ], { fuzzy: true });
      if (!pick || pick === "x Cancel") return;
      const id = matchProfileIdFromLine(pick, readyIds);
      if (!id) return;
      profileId = id;
    }

    const dlConfig = store.profiles[profileId] || loadConfig();
    if (!isBackendConfigured(dlConfig)) {
      ctx.ui.notify("Selected profile is not fully configured. Open Configure Active Profile or switch profile.", "error");
      return;
    }
    try {
      await ensureTarAvailable();
    } catch (e) {
      ctx.ui.notify(`❌ ${formatError(e)}`, "error");
      return;
    }
    resetS3ClockSkew();
    ctx.ui.notify(`Fetching backups from [${profileId}] ${backendLabel(dlConfig)}...`, "info");
    try {
      const backups = await listCloudBackups(dlConfig, ctx);
      if (backups.length === 0) {
        ctx.ui.notify("No cloud backups found starting with 'pi_sync_backup_' (.tar.gz or legacy .zip).", "warning");
        return;
      }

      const backupChoice = await enhancedSelect(ctx, "Select cloud backup to restore:", [
        ...backups,
        "❌ Cancel",
      ], { fuzzy: true });

      if (!backupChoice || backupChoice.includes("Cancel")) return;

      const tempDownloadZip = path.join(os.tmpdir(), path.basename(backupChoice));
      try {
        ctx.ui.notify(`Downloading ${backupChoice}...`, "info");
        await yieldToUI();
        await downloadFromCloud(backupChoice, tempDownloadZip, dlConfig, ctx);

        const archiveEntries = await listArchiveEntries(tempDownloadZip);
        validateArchiveEntries(archiveEntries);

        // Stage the restore: extract, read manifest, compute path rebases —
        // nothing touches the agent dir until the user confirms.
        ctx.ui.notify("Inspecting archive (staging restore plan)...", "info");
        await yieldToUI();
        const staged = await stageRestore(tempDownloadZip, dlConfig);
        try {
          const preview = buildRestorePreview(staged, dlConfig);
          const confirmed = await ctx.ui.confirm(
            "Confirm Restore After Inspection?",
            [
              `Backup: ${backupChoice}`,
              `Profile: ${profileId}`,
              `Backend: ${dlConfig.backend}`,
              `Archive entries inspected: ${archiveEntries.length}`,
              ...preview,
              "This can overwrite local configuration/skills/extensions, but existing local files/directories will receive timestamped backups first.",
            ].join("\n"),
          );

          if (!confirmed) {
            ctx.ui.notify("Restore cancelled after archive inspection.", "info");
            return;
          }

          const packagesBefore = readSettingsPackages();
          ctx.ui.notify("Applying staged restore...", "info");
          await yieldToUI();
          const { restored, safetyBackups } = await applyStagedRestore(staged, dlConfig);
          const packagesAfter = readSettingsPackages();
          const report = formatRestoreReport({
            backupName: backupChoice,
            restored,
            safetyBackups,
            packagesBefore,
            packagesAfter,
            portabilityLines: preview.slice(preview.indexOf("── Path portability ──") + 1),
          });
          ctx.ui.notify(`🎉 Restore finished\n${report}`, "info");

          const doReload = await ctx.ui.confirm(
            "Reload Runtime?",
            "Reload the agent runtime now to apply restored skills, extensions, and packages?",
          );
          if (doReload) await ctx.reload();
        } finally {
          try {
            fs.rmSync(staged.stageDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      } finally {
        if (fs.existsSync(tempDownloadZip)) {
          try { fs.unlinkSync(tempDownloadZip); } catch { /* ignore */ }
        }
      }
    } catch (e) {
      ctx.ui.notify(`❌ Restore failed: ${formatError(e)}`, "error");
    }
  }


  function matchProfileIdFromLine(line: string, ids: string[]): string | undefined {
    return (
      ids.find((id) => line.includes(`(${id})`) || line.includes(` ${id} —`) || line.startsWith(`● ${id}`) || line.startsWith(`○ ${id}`))
      || ids.find((id) => line.includes(id))
    );
  }

  async function showManageProfiles(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      const store = loadStore();
      const ids = listProfileIds(store);
      const lines = ids.map((id) => profileSummary(id, store.profiles[id], id === store.activeProfile));
      const selected = await enhancedSelect(ctx, "Profiles", [
        ...lines,
        "───────────────",
        "+ Add profile",
        "✎ Rename active display name",
        "⎘ Duplicate active profile",
        "🗑 Delete a profile",
        "x Back",
      ], { fuzzy: true });
      if (!selected || selected === "x Back") return;

      if (selected === "+ Add profile") {
        const idRaw = await ctx.ui.input("New profile id (letters, numbers, ._-):", "");
        if (!idRaw) continue;
        const id = sanitizeProfileId(idRaw);
        if (store.profiles[id]) {
          ctx.ui.notify(`Profile "${id}" already exists`, "warning");
          continue;
        }
        const display = await ctx.ui.input("Display name (optional):", id);
        const cfg = defaultConfig(display || id);
        const backendChoice = await enhancedSelect(ctx, `Backend for ${id}`, [
          "WebDAV",
          "S3-compatible",
          "❌ Cancel",
        ]);
        if (!backendChoice || backendChoice.includes("Cancel")) continue;
        if (backendChoice.startsWith("S3")) {
          cfg.backend = "s3";
          if (!await configureS3Fields(ctx, cfg)) continue;
        } else {
          cfg.backend = "webdav";
          if (!await configureWebdavFields(ctx, cfg)) continue;
        }
        store.profiles[id] = normalizeConfig(cfg, display || id);
        store.activeProfile = id;
        saveStore(store);
        ctx.ui.notify(`Profile "${id}" created and activated`, "info");
        continue;
      }

      if (selected === "✎ Rename active display name") {
        const cfg = store.profiles[store.activeProfile];
        if (!cfg) continue;
        const val = await ctx.ui.input("Display name:", cfg.name || store.activeProfile);
        if (!val) continue;
        cfg.name = val.trim();
        store.profiles[store.activeProfile] = cfg;
        saveStore(store);
        ctx.ui.notify("Display name updated", "info");
        continue;
      }

      if (selected === "⎘ Duplicate active profile") {
        const srcId = store.activeProfile;
        const src = store.profiles[srcId];
        if (!src) continue;
        const idRaw = await ctx.ui.input(`Duplicate "${srcId}" as new id:`, `${srcId}-copy`);
        if (!idRaw) continue;
        const id = sanitizeProfileId(idRaw);
        if (store.profiles[id]) {
          ctx.ui.notify(`Profile "${id}" already exists`, "warning");
          continue;
        }
        store.profiles[id] = normalizeConfig({ ...src, name: id }, id);
        store.activeProfile = id;
        saveStore(store);
        ctx.ui.notify(`Duplicated to "${id}" and activated`, "info");
        continue;
      }

      if (selected === "🗑 Delete a profile") {
        if (ids.length <= 1) {
          ctx.ui.notify("Cannot delete the only profile", "warning");
          continue;
        }
        const del = await enhancedSelect(ctx, "Delete profile", [
          ...ids.map((id) => profileSummary(id, store.profiles[id], id === store.activeProfile)),
          "x Cancel",
        ], { fuzzy: true });
        if (!del || del === "x Cancel") continue;
        const delId = matchProfileIdFromLine(del, ids);
        if (!delId || !store.profiles[delId]) continue;
        const ok = await ctx.ui.confirm("Delete profile?", `Delete profile "${delId}"? This cannot be undone.`);
        if (!ok) continue;
        delete store.profiles[delId];
        if (store.activeProfile === delId) {
          store.activeProfile = Object.keys(store.profiles).sort()[0];
        }
        saveStore(store);
        ctx.ui.notify(`Deleted "${delId}". Active: ${store.activeProfile}`, "info");
        continue;
      }

      const activateId = matchProfileIdFromLine(selected, ids);
      if (activateId && store.profiles[activateId]) {
        store.activeProfile = activateId;
        saveStore(store);
        ctx.ui.notify(`Active profile: ${activateId}`, "info");
      }
    }
  }

  async function showSwitchProfile(ctx: ExtensionCommandContext): Promise<void> {
    const store = loadStore();
    const ids = listProfileIds(store);
    if (ids.length === 0) {
      ctx.ui.notify("No profiles configured", "warning");
      return;
    }
    const selected = await enhancedSelect(ctx, "Switch profile", [
      ...ids.map((id) => profileSummary(id, store.profiles[id], id === store.activeProfile)),
      "x Cancel",
    ], { fuzzy: true });
    if (!selected || selected === "x Cancel") return;
    const id = matchProfileIdFromLine(selected, ids);
    if (!id) return;
    store.activeProfile = id;
    saveStore(store);
    ctx.ui.notify(`Switched to profile: ${id} — ${backendLabel(store.profiles[id])}`, "info");
  }

  // Register command `/sync`
  pi.registerCommand("sync", {
    description: "Sync configurations, skills, and extensions via WebDAV or S3",
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => {
      try {
      // Persist one-time migration from legacy flat sync_config.json → v2 multi-profile
      const probe = readJsonSafe<Record<string, unknown>>(SYNC_CONFIG_PATH, {});
      if (probe && Object.keys(probe).length > 0 && isLegacyFlatConfig(probe)) {
        saveStore(loadStore());
      }

      if (!isBackendConfigured(loadConfig())) {
        if (!await showSetupWizard(ctx)) return;
      }

      // Main menu loops: after any sub-action returns, re-show it (recomputing
      // title/ready-count) so navigating up from a submenu lands here, not chat.
      // Only Cancel / Esc exits back to the conversation.
      while (true) {
        const store = loadStore();
        const config = loadConfig();
        const readyCount = listProfileIds(store).filter((id) => isBackendConfigured(store.profiles[id])).length;
        const menuOptions = [
          "☁️  Upload Backup (active profile)",
          "☁️☁️ Upload to Multiple Profiles (pack once)",
          "📥  Download Backup (pick source profile)",
          `🔀  Switch Profile (active: ${store.activeProfile})`,
          "📋  Manage Profiles (add / duplicate / delete)",
          "⚙️  Configure Active Profile",
          "❌  Exit",
        ];
        const choice = await enhancedSelect(
          ctx,
          `Pi Cloud Sync [${store.activeProfile}] (${config.backend === "s3" ? "S3" : "WebDAV"}) · ${readyCount} ready`,
          menuOptions,
        );
        if (!choice || choice.includes("Exit")) return;

        if (choice.includes("Manage Profiles")) await showManageProfiles(ctx);
        else if (choice.includes("Switch Profile")) await showSwitchProfile(ctx);
        else if (choice.includes("Configure")) await showConfigureSettings(ctx);
        else if (choice.includes("Multiple Profiles")) await showUploadBackup(ctx, true);
        else if (choice.includes("Upload Backup")) await showUploadBackup(ctx, false);
        else if (choice.includes("Download Backup")) await showDownloadBackup(ctx);
      }
      } catch (e) {
        const msg = formatError(e);
        // Never re-enter formatError/errMsg recursion paths for this shell.
        try {
          ctx.ui.notify(`❌ /sync failed: ${msg}`, "error");
        } catch {
          // ignore UI failures
        }
      }
    },
  });
}
