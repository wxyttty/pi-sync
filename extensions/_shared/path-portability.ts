/**
 * Cross-system path portability for pi-sync.
 *
 * Pure logic — no fs imports. The restore flow injects an `exists` predicate.
 *
 * Responsibilities:
 *   - Parse/validate the backup manifest (source machine identity).
 *   - Rebase absolute paths from the source machine's home/agent-dir to the
 *     target machine's, using the SOURCE platform's path semantics
 *     (path.win32 for Windows sources, path.posix otherwise).
 *   - Only well-known path fields are rewritten (settings resources,
 *     mcp command/cwd/whole-path args). Everything else is report-only.
 *   - Detect device-local URLs (loopback / RFC1918) for the restore report.
 *
 * Import: import { … } from "../_shared/path-portability"
 */

import * as nodePath from "node:path";

// ── Manifest ─────────────────────────────────────────────────────────────

export interface ManifestSource {
  /** os.platform() of the source machine, e.g. "linux" | "win32" | "darwin". */
  platform: string;
  /** Backup filename platform tag, e.g. "windows11" | "linux" | "macos". */
  platformTag: string;
  /** Source home directory in native separators, e.g. "C:\\Users\\wxy". */
  home: string;
  /** Source agent directory, e.g. "C:\\Users\\wxy\\.pi\\agent". */
  agentDir: string;
}

export interface SyncManifest {
  version: number;
  piSyncVersion: string;
  createdAt: string;
  source: ManifestSource;
}

/**
 * Strictly parse a manifest object. Throws a descriptive Error when malformed
 * or unsupported, so a broken manifest fails inspection instead of silently
 * degrading to a legacy verbatim restore.
 */
export function parseManifest(raw: unknown): SyncManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest.json is not a JSON object");
  }
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) {
    throw new Error(`manifest.json has unsupported version ${JSON.stringify(m.version)}`);
  }
  const src = m.source;
  if (src === null || typeof src !== "object" || Array.isArray(src)) {
    throw new Error("manifest.json is missing the source object");
  }
  const s = src as Record<string, unknown>;
  const home = typeof s.home === "string" ? s.home.trim() : "";
  const agentDir = typeof s.agentDir === "string" ? s.agentDir.trim() : "";
  const platform = typeof s.platform === "string" ? s.platform.trim() : "";
  if (!home || !agentDir || !platform) {
    throw new Error("manifest.json source is incomplete (home/agentDir/platform required)");
  }
  if (!/^[a-z0-9]+$/i.test(platform)) {
    throw new Error(`manifest.json source.platform is not a valid platform id: ${JSON.stringify(platform)}`);
  }
  const win = platform === "win32";
  const isAbsoluteOnSource = (p: string): boolean =>
    win ? /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) : p.startsWith("/");
  if (!isAbsoluteOnSource(home)) {
    throw new Error(`manifest.json source.home is not an absolute path on ${platform}: ${JSON.stringify(home)}`);
  }
  if (!isAbsoluteOnSource(agentDir)) {
    throw new Error(`manifest.json source.agentDir is not an absolute path on ${platform}: ${JSON.stringify(agentDir)}`);
  }
  return {
    version: 1,
    piSyncVersion: typeof m.piSyncVersion === "string" ? m.piSyncVersion : "",
    createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
    source: {
      platform,
      platformTag: typeof s.platformTag === "string" ? s.platformTag : "",
      home,
      agentDir,
    },
  };
}

// ── Rebase types ─────────────────────────────────────────────────────────

export interface PathRebase {
  /** JSON field path, e.g. "settings.extensions[2]". */
  field: string;
  from: string;
  to: string;
  /** Whether the rebased target exists on this machine. */
  exists: boolean;
}

export type WarningKind =
  | "missing-path"      // rebased path does not exist here
  | "loopback-url"      // 127.0.0.1 / localhost / [::1]
  | "private-url"       // RFC1918 LAN address
  | "unrebased-path"    // absolute source path in a field we never rewrite
  | "command-path"      // command string that embeds a source path
  | "local-package";    // relative/absolute local package source

export interface PortabilityWarning {
  field: string;
  value: string;
  kind: WarningKind;
  hint?: string;
}

export interface RebaseContext {
  sourceHome: string;
  sourceAgentDir: string;
  /** os.platform() of the source machine ("win32" selects Windows semantics). */
  sourcePlatform: string;
  targetHome: string;
  targetAgentDir: string;
  /** Existence check injected by the caller (fs.existsSync). */
  exists: (p: string) => boolean;
}

export interface RebaseResult {
  /** New (deep-cloned and rebased) JSON value. */
  value: unknown;
  rebases: PathRebase[];
  warnings: PortabilityWarning[];
}

// ── Path helpers (source-platform semantics) ─────────────────────────────

/** True for values with a URI-ish scheme that are not Windows drive paths. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;


/** Heuristic: could this string be a filesystem path at all? */
export function isPathLikeValue(s: string): boolean {
  if (!s || s.length > 4096) return false;
  if (WINDOWS_DRIVE_RE.test(s)) return true;
  if (SCHEME_RE.test(s)) return false; // npm:, git:, http://, … are not paths
  return s.startsWith("/") || s.startsWith("\\\\") || s.startsWith("~");
}

/**
 * Split `value` into a path relative to `base` when value is base itself or
 * lies underneath it. Uses source-platform separators; on Windows both `/`
 * and `\` are accepted and comparison is case-insensitive. Returns undefined
 * otherwise.
 *
 * Prefix-lookalike safe: "/home/alice" is NOT under "/home/a".
 */
export function splitUnderBase(value: string, base: string, sourcePlatform: string): string | undefined {
  const win = sourcePlatform === "win32";
  // Normalize to a single separator: backslash for Windows sources, slash for
  // POSIX (a literal backslash is a valid POSIX filename character).
  const sep = win ? "\\" : "/";
  const norm = (p: string): string => {
    let n = win ? p.replace(/[\\/]+/g, "\\") : p.replace(/\/+/g, "/");
    // strip one trailing separator, but keep drive roots like "C:\"
    const isDriveRoot = win && /^[a-zA-Z]:\\?$/.test(n);
    if (!isDriveRoot && n.length > 1 && n.endsWith(sep)) n = n.slice(0, -1);
    return n;
  };
  // Case-insensitive comparison on Windows, but preserve the original case in
  // the returned relative part. toLowerCase can change string length for some
  // Unicode; bail out (undefined) in that rare case rather than mis-slice.
  const fold = (s: string): string => (win ? s.toLowerCase() : s);
  const nv = norm(value);
  const nb = norm(base);
  const fv = fold(nv);
  const fb = fold(nb);
  if (fv === fb) return "";
  if (fv.length !== nv.length || fb.length !== nb.length) return undefined;
  // Boundary: nb may already end with the separator (drive root "C:\").
  const boundary = fb.endsWith(sep) ? fb : fb + sep;
  if (fv.startsWith(boundary)) {
    // Relative part from the NORMALIZED value — separator counts can differ
    // between value and base, so never slice the original strings.
    return nv.slice(boundary.length);
  }
  return undefined;
}


/**
 * Join a relative path (source separators) onto a target base with local
 * separators. Split on both separators only for Windows sources; POSIX
 * sources keep literal backslashes inside filenames.
 */
function joinTarget(base: string, rel: string, sourcePlatform: string): string {
  if (!rel) return base;
  const parts = (sourcePlatform === "win32" ? rel.split(/[\\/]+/) : rel.split("/+")).filter(Boolean);
  return nodePath.join(base, ...parts);
}

/** Rebase one string against agentDir (most specific) then home. */
function rebaseString(
  s: string,
  ctx: RebaseContext,
): { value: string; rebase?: { from: string; to: string } } {
  if (!isPathLikeValue(s)) return { value: s };
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) return { value: s }; // already portable

  const relAgent = splitUnderBase(s, ctx.sourceAgentDir, ctx.sourcePlatform);
  if (relAgent !== undefined) {
    const to = joinTarget(ctx.targetAgentDir, relAgent, ctx.sourcePlatform);
    return { value: to, rebase: { from: s, to } };
  }
  const relHome = splitUnderBase(s, ctx.sourceHome, ctx.sourcePlatform);
  if (relHome !== undefined) {
    const to = joinTarget(ctx.targetHome, relHome, ctx.sourcePlatform);
    return { value: to, rebase: { from: s, to } };
  }
  return { value: s };
}

/** Strip a resource-array control prefix ("!", "+", "-") if present. */
function splitResourcePrefix(entry: string): { prefix: string; path: string } {
  const m = entry.match(/^([!+-])(.*)$/s);
  if (m) return { prefix: m[1], path: m[2] };
  return { prefix: "", path: entry };
}

// ── URL scanning ─────────────────────────────────────────────────────────

const LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:[\/?#]|$)/i;
const PRIVATE_RE = /^https?:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(?::[0-9]+)?(?:[\/?#]|$)/i;

/** Classify a URL as device-local (loopback) / LAN-private / neither. */
export function classifyUrl(url: string): "loopback" | "private" | "external" | "not-url" {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return "not-url";
  if (LOOPBACK_RE.test(url)) return "loopback";
  if (PRIVATE_RE.test(url)) return "private";
  return "external";
}

// ── Per-file rebase rules ────────────────────────────────────────────────

interface FieldOutcome {
  value: unknown;
  rebases: PathRebase[];
  warnings: PortabilityWarning[];
}

function emptyOutcome(): FieldOutcome {
  return { value: undefined, rebases: [], warnings: [] };
}

/** Rebase one whole-string path field; record a warning when target is missing. */
function rebaseWholeString(
  field: string,
  s: string,
  ctx: RebaseContext,
  outcome: FieldOutcome,
): string {
  const r = rebaseString(s, ctx);
  if (r.rebase) {
    const exists = ctx.exists(r.value);
    outcome.rebases.push({ field, from: r.rebase.from, to: r.rebase.to, exists });
    if (!exists) {
      outcome.warnings.push({
        field,
        value: r.value,
        kind: "missing-path",
        hint: "rebased path does not exist on this machine",
      });
    }
    return r.value;
  }
  // Not under source home/agentDir. Absolute and foreign? Report only.
  if (isPathLikeValue(s) && !s.startsWith("~")) {
    outcome.warnings.push({
      field,
      value: s,
      kind: "unrebased-path",
      hint: "absolute path outside the source home; restored as-is",
    });
  }
  return s;
}

/** Rebase a resource array entry, preserving !/+/- control prefixes. */
function rebaseResourceEntry(
  field: string,
  entry: string,
  ctx: RebaseContext,
  outcome: FieldOutcome,
): string {
  const { prefix, path: p } = splitResourcePrefix(entry);
  if (!isPathLikeValue(p)) return entry; // npm:/git:/builtin:/URL entries untouched
  const r = rebaseString(p, ctx);
  if (r.rebase) {
    const exists = ctx.exists(r.value);
    outcome.rebases.push({ field, from: entry, to: prefix + r.value, exists });
    if (!exists) {
      outcome.warnings.push({
        field,
        value: r.value,
        kind: "missing-path",
        hint: "rebased path does not exist on this machine",
      });
    }
    return prefix + r.value;
  }
  if (nodePath.posix.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
    outcome.warnings.push({
      field,
      value: entry,
      kind: "unrebased-path",
      hint: "absolute path outside the source home; restored as-is",
    });
  }
  return entry;
}

function rebaseStringArray(
  fieldBase: string,
  arr: unknown[],
  ctx: RebaseContext,
  outcome: FieldOutcome,
  mode: "resource" | "plain",
): unknown[] {
  return arr.map((entry, i) => {
    const field = `${fieldBase}[${i}]`;
    if (typeof entry !== "string") return entry;
    return mode === "resource"
      ? rebaseResourceEntry(field, entry, ctx, outcome)
      : rebaseWholeString(field, entry, ctx, outcome);
  });
}

/** settings.json: known path fields. */
function rebaseSettings(obj: Record<string, unknown>, ctx: RebaseContext): FieldOutcome {
  const outcome = emptyOutcome();
  const value: Record<string, unknown> = { ...obj };

  for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
    const v = obj[key];
    if (Array.isArray(v)) {
      value[key] = rebaseStringArray(`settings.${key}`, v as unknown[], ctx, outcome, "resource");
    }
  }

  // Whole-string path settings
  for (const key of ["sessionDir", "shellPath"] as const) {
    const v = obj[key];
    if (typeof v === "string") value[key] = rebaseWholeString(`settings.${key}`, v, ctx, outcome);
  }
  // externalEditor is a command string; rebase only when it is a bare path
  // (no whitespace). Command strings with arguments are report-only.
  const ee = obj.externalEditor;
  if (typeof ee === "string" && ee) {
    if (isPathLikeValue(ee) && !/\s/.test(ee)) {
      value.externalEditor = rebaseWholeString("settings.externalEditor", ee, ctx, outcome);
    } else if (embedsSourcePath(ee, ctx)) {
      outcome.warnings.push({
        field: "settings.externalEditor",
        value: redactValue(ee),
        kind: "command-path",
        hint: "command embeds a source-machine path; edit manually if needed",
      });
    }
  }

  // npmCommand is a command + args; report only when it embeds a source path.
  if (Array.isArray(obj.npmCommand)) {
    (obj.npmCommand as unknown[]).forEach((c, i) => {
      if (typeof c === "string" && embedsSourcePath(c, ctx)) {
        outcome.warnings.push({
          field: `settings.npmCommand[${i}]`,
          value: c,
          kind: "command-path",
          hint: "command embeds a source-machine path; edit manually if needed",
        });
      }
    });
  }

  // packages: local sources are machine-relative; report only.
  if (Array.isArray(obj.packages)) {
    (obj.packages as unknown[]).forEach((p, i) => {
      const src = typeof p === "string" ? p : (p as { source?: string } | null)?.source;
      if (typeof src === "string" && (src.startsWith("./") || src.startsWith("../") || isPathLikeValue(src))) {
        outcome.warnings.push({
          field: `settings.packages[${i}]`,
          value: src,
          kind: "local-package",
          hint: "local package path; verify it exists on this machine",
        });
      }
    });
  }

  outcome.value = value;
  return outcome;
}

/** mcp.json: command/cwd/whole-path args are rebased; url is scanned. */
function rebaseMcp(obj: Record<string, unknown>, ctx: RebaseContext): FieldOutcome {
  const outcome = emptyOutcome();
  const value: Record<string, unknown> = { ...obj };
  const servers = obj.mcpServers;

  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    const newServers: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        newServers[name] = raw;
        continue;
      }
      const srv = { ...(raw as Record<string, unknown>) };
      const base = `mcp.mcpServers.${name}`;

      if (typeof srv.command === "string") {
        srv.command = rebaseWholeString(`${base}.command`, srv.command, ctx, outcome);
      }
      if (typeof srv.cwd === "string") {
        srv.cwd = rebaseWholeString(`${base}.cwd`, srv.cwd, ctx, outcome);
      }
      if (Array.isArray(srv.args)) {
        const newArgs = rebaseStringArray(`${base}.args`, srv.args as unknown[], ctx, outcome, "plain");
        // URL-valued args (e.g. --base-url http://192.168.x.x) are not paths;
        // classify them for device/LAN-local warnings.
        (newArgs as unknown[]).forEach((a, i) => {
          if (typeof a !== "string") return;
          const cls = classifyUrl(a);
          if (cls === "loopback" || cls === "private") {
            outcome.warnings.push({
              field: `${base}.args[${i}]`,
              value: a,
              kind: cls === "loopback" ? "loopback-url" : "private-url",
              hint: cls === "loopback"
                ? "device-local URL — needs a service running on this machine"
                : "LAN-local URL — may not be reachable from this machine",
            });
          }
        });
        srv.args = newArgs;
      }
      if (typeof srv.url === "string") {
        const cls = classifyUrl(srv.url);
        if (cls === "loopback" || cls === "private") {
          outcome.warnings.push({
            field: `${base}.url`,
            value: srv.url,
            kind: cls === "loopback" ? "loopback-url" : "private-url",
            hint: cls === "loopback"
              ? "device-local URL — needs a service running on this machine"
              : "LAN-local URL — may not be reachable from this machine",
          });
        }
      }
      // env values may embed paths in commands; report only.
      if (srv.env && typeof srv.env === "object" && !Array.isArray(srv.env)) {
        for (const [k, v] of Object.entries(srv.env as Record<string, unknown>)) {
          if (typeof v === "string" && embedsSourcePath(v, ctx)) {
            outcome.warnings.push({
              field: `${base}.env.${k}`,
              value: v,
              kind: "command-path",
              hint: "value embeds a source-machine path; edit manually if needed",
            });
          }
        }
      }
      newServers[name] = srv;
    }
    value.mcpServers = newServers;
  }

  outcome.value = value;
  return outcome;
}

/** models.json: baseUrl scanned; command fields report-only. */
function rebaseModels(obj: Record<string, unknown>, ctx: RebaseContext): FieldOutcome {
  const outcome = emptyOutcome();
  const value: Record<string, unknown> = { ...obj };
  const providers = obj.providers;

  if (providers && typeof providers === "object" && !Array.isArray(providers)) {
    const newProviders: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(providers as Record<string, unknown>)) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        newProviders[name] = raw;
        continue;
      }
      const prov = { ...(raw as Record<string, unknown>) };
      const base = `models.providers.${name}`;

      if (typeof prov.baseUrl === "string") {
        const cls = classifyUrl(prov.baseUrl);
        if (cls === "loopback" || cls === "private") {
          outcome.warnings.push({
            field: `${base}.baseUrl`,
            value: prov.baseUrl,
            kind: cls === "loopback" ? "loopback-url" : "private-url",
            hint: cls === "loopback"
              ? "device-local provider — needs a local service/proxy on this machine"
              : "LAN-local provider — may not be reachable from this machine",
          });
        }
      }
      for (const key of ["command", "apiKeyCommand"] as const) {
        const v = prov[key];
        if (typeof v === "string" && embedsSourcePath(v, ctx)) {
          outcome.warnings.push({
            field: `${base}.${key}`,
            value: v,
            kind: "command-path",
            hint: "command embeds a source-machine path; edit manually if needed",
          });
        }
      }
      newProviders[name] = prov;
    }
    value.providers = newProviders;
  }

  outcome.value = value;
  return outcome;
}

/**
 * Redact a value for diagnostics: strip URL query strings (may carry API
 * keys), then truncate. Never print full secrets in warnings.
 */
export function redactValue(v: string): string {
  let s = v;
  // strip URL query (and fragment) — e.g. ?exaApiKey=…
  if (/^https?:\/\//i.test(s)) {
    const q = s.search(/[?#]/);
    if (q >= 0) s = s.slice(0, q) + "?…";
  }
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

/** True when the string contains the source home/agentDir as a substring. */
function embedsSourcePath(s: string, ctx: RebaseContext): boolean {
  if (typeof s !== "string" || s.length < 4) return false;
  const win = ctx.sourcePlatform === "win32";
  const hay = win ? s.toLowerCase() : s;
  const home = win ? ctx.sourceHome.toLowerCase() : ctx.sourceHome;
  const agent = win ? ctx.sourceAgentDir.toLowerCase() : ctx.sourceAgentDir;
  return hay.includes(home) || hay.includes(agent);
}

/**
 * Deep report-only scan for source paths in fields we never rewrite.
 * Field paths use the SAME representation as the per-file rules
 * ("settings.extensions[0]"), so deduplication against transformed fields
 * works. Scalar array leaves are visited (not just object values).
 */
function scanGeneric(
  obj: unknown,
  ctx: RebaseContext,
  fieldRoot: string,
  outcome: FieldOutcome,
  touched: Set<string>,
  prefix: string,
  depth: number,
): void {
  if (depth > 12) return;
  const fieldFor = (key: string): string => (prefix ? `${prefix}.${key}` : key);
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      const child = `${prefix}[${i}]`;
      if (typeof v === "string") visitLeaf(v, child);
      else if (v !== null && typeof v === "object") scanGeneric(v, ctx, fieldRoot, outcome, touched, child, depth + 1);
    });
    return;
  }
  if (obj === null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const field = fieldFor(k);
    if (typeof v === "string") {
      visitLeaf(v, field);
    } else if (v !== null && typeof v === "object") {
      scanGeneric(v, ctx, fieldRoot, outcome, touched, field, depth + 1);
    }
  }

  function visitLeaf(v: string, field: string): void {
    const full = `${fieldRoot}.${field}`;
    if (touched.has(full)) return; // already rebased or reported by per-file rules
    if (embedsSourcePath(v, ctx)) {
      outcome.warnings.push({
        field: full,
        value: redactValue(v),
        kind: "unrebased-path",
        hint: "field embeds a source-machine path; not rewritten (unknown field)",
      });
      return;
    }
    const cls = classifyUrl(v);
    if (cls === "loopback" || cls === "private") {
      outcome.warnings.push({
        field: full,
        value: redactValue(v),
        kind: cls === "loopback" ? "loopback-url" : "private-url",
        hint: "device/LAN-local URL — may need a local service on this machine",
      });
    }
  }
}

/**
 * Rebase one restored config file by name. Unknown files (plugin configs)
 * get report-only scanning — no string is ever rewritten for them.
 */
export function rebaseConfigFile(
  fileName: string,
  obj: unknown,
  ctx: RebaseContext,
): RebaseResult {
  const outcome =
    obj !== null && typeof obj === "object" && !Array.isArray(obj)
      ? (() => {
          if (fileName === "settings.json") return rebaseSettings(obj as Record<string, unknown>, ctx);
          if (fileName === "mcp.json") return rebaseMcp(obj as Record<string, unknown>, ctx);
          if (fileName === "models.json") return rebaseModels(obj as Record<string, unknown>, ctx);
          return emptyOutcome();
        })()
      : emptyOutcome();

  // Generic report-only scan for every file (including the known ones, for
  // fields the per-file rules do not cover). Fields already rebased or
  // reported by the per-file rules are suppressed via the touched set.
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    const fieldRoot =
      fileName === "settings.json" ? "settings"
      : fileName === "mcp.json" ? "mcp"
      : fileName === "models.json" ? "models"
      : fileName;
    const touched = new Set<string>([
      ...outcome.rebases.map((r) => r.field),
      ...outcome.warnings.map((w) => w.field),
    ]);
    scanGeneric(obj, ctx, fieldRoot, outcome, touched, "", 0);
  }

  return {
    value: outcome.value !== undefined ? outcome.value : obj,
    rebases: outcome.rebases,
    warnings: outcome.warnings,
  };
}

/** Build a RebaseContext from a manifest plus this machine's dirs. */
export function rebaseContextFromManifest(
  manifest: SyncManifest,
  targetHome: string,
  targetAgentDir: string,
  exists: (p: string) => boolean,
): RebaseContext {
  return {
    sourceHome: manifest.source.home,
    sourceAgentDir: manifest.source.agentDir,
    sourcePlatform: manifest.source.platform,
    targetHome,
    targetAgentDir,
    exists,
  };
}
