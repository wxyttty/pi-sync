# pi-sync

**English** | [简体中文](./README.zh-CN.md)

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![release](https://img.shields.io/github/v/release/BevalZ/pi-sync?display_name=tag&sort=semver)](https://github.com/BevalZ/pi-sync/releases)

WebDAV / S3 config sync for [Pi](https://github.com/earendil-works/pi-coding-agent) — backup and restore **models**, **settings**, **skills**, and **extensions** across machines.

Run `/sync`, pick an action from the menu. One machine uploads; another downloads and restores.

<p align="center">
  <img src="docs/sync-menu.png" alt="Pi WebDAV Synchronization menu" width="720" />
</p>

<p align="center"><sub><b>Pi WebDAV Synchronization</b> — interactive menu after <code>/sync</code></sub></p>

## Why

If you run Pi on multiple PCs / WSL / servers, reinstalling models, skills, and extensions by hand is painful. `pi-sync` packages your agent home into a timestamped zip, uploads it to WebDAV or an S3-compatible bucket, and restores it with local safety backups.

## Install

Requires [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) and either a **WebDAV** endpoint (TeraCLOUD, 坚果云 / Jianguoyun, Nextcloud, ownCloud, …) or an **S3-compatible** bucket (Amazon S3, MinIO, Cloudflare R2, …).

```bash
pi install git:github.com/BevalZ/pi-sync@v1.4.0
```

Then restart Pi or run `/reload`.

## Usage

Type **`/sync`** in Pi. There are no CLI subcommands — everything goes through the interactive menu:

| Menu item | What it does |
|-----------|----------------|
| ☁️ **Upload Backup (active profile)** | Zip once and upload to the **active** profile |
| ☁️☁️ **Upload to Multiple Profiles** | Zip **once**, then upload the same archive to several ready profiles |
| 📥 **Download Backup** | Pick a source profile (if more than one), list remote backups, restore with confirmation |
| 🔀 **Switch Profile** | Change the active profile |
| 📋 **Manage Profiles** | Add / duplicate / delete / rename profiles |
| ⚙️ **Configure Active Profile** | Edit backend credentials and include flags for the active profile |
| ❌ **Cancel** | Leave the menu |

Keyboard hints (as shown in the TUI): `↵` select · `↑↓` navigate · `Esc` cancel.

### First-time setup

```bash
# 1. Install
pi install git:github.com/BevalZ/pi-sync@v1.4.0

# 2. Open the menu (first run starts the setup wizard if WebDAV is empty)
/sync

# 3. If needed: Configure Active Profile
#    enter URL / user / password
#    tip: set password to $PI_WEBDAV_PASS and export that env var

# 4. On your main machine → Upload Backup (Backup to cloud)
# 5. On a new machine (after install + configure) → Download Backup (Restore from cloud)
```

### S3 backend

Under **Configure Active Profile**, set **Backend** to S3-compatible and fill:

| Field | Notes |
|-------|--------|
| Bucket | Required |
| Region | e.g. `us-east-1`, `ap-northeast-1` |
| Access key / Secret key | Prefer `$ENV_VAR` references |
| Session token | Optional (temporary credentials) |
| Endpoint | Optional — leave empty for AWS; set for MinIO / R2 / OSS |
| Prefix | Object key prefix, default `pi-backups/` |
| Path-style | Default ON for custom endpoints |

Example single-profile fields (stored under `profiles.<id>` in v2):

```json
{
  "backend": "s3",
  "s3Bucket": "my-pi-backups",
  "s3Region": "ap-northeast-1",
  "s3AccessKeyId": "$AWS_ACCESS_KEY_ID",
  "s3SecretAccessKey": "$AWS_SECRET_ACCESS_KEY",
  "s3Endpoint": "",
  "s3Prefix": "pi-backups/",
  "s3ForcePathStyle": false,
  "backupProviders": true,
  "backupSkills": true,
  "backupExtensions": true
}
```

Existing WebDAV configs keep working: omitted `backend` is treated as `webdav`.

### Multiple profiles

You can keep several cloud targets (e.g. home WebDAV + Cloudflare R2) in one `sync_config.json`:

1. `/sync` → **Manage Profiles** → **Add profile**
2. `/sync` → **Switch Profile** to choose the active one for single-target upload
3. `/sync` → **Upload to Multiple Profiles** to pack **once** and push the same zip to several backends (e.g. WebDAV + R2)
4. **Download** lets you pick which profile to list/restore from when more than one is ready

Legacy single-file `sync_config.json` is upgraded to v2 on first open (your old settings become profile `default`).

See `docs/sync_config.example.json` for a no-secrets multi-profile template.

### What gets synced

| Component | Default | Notes |
|-----------|---------|-------|
| Config | ON | `models.json`, `settings.json`, `auth.json`, `mcp.json` |
| Extra config files | OFF (allowlist) | plugin configs in the agent dir root, e.g. `pi-fff.json` — pick files under **Configure Active Profile → Extra config files** |
| Skills | ON | entire `~/.pi/agent/skills` |
| Extensions | ON | `~/.pi/agent/extensions` (the sync plugin itself is excluded from the zip) |

`sync_config.json` (cloud credentials) is never packed or restored. `mcp-auth.json` (OAuth grants) is not synced by default either — add it to the extra-config allowlist only if you understand the implications.

Toggle any of these under **Configure Active Profile**.

### Cross-system path portability

Backups made with v1.4.0+ carry a `manifest.json` that records the source machine's home and agent directories. On restore:

- Absolute paths in **known path fields** (`settings.json` resources like `extensions` / `skills` / `prompts` / `themes`, `sessionDir`, `shellPath`, and `mcp.json` `command` / `cwd` / whole-path `args`) are **rebased** from the source home to this machine's home — `/home/alice/…` → `/home/bob/…`, `C:\Users\wxy\…` → `/home/bob/…`, with separator conversion. Paths inside the source agent dir are rebased to this machine's agent dir (which also respects `PI_CODING_AGENT_DIR`).
- Resource control prefixes (`!`, `+`, `-`) and non-path entries (`npm:…`, `git:…`, `builtin:…`, URLs) pass through untouched.
- Everything else is **report-only**: the restore preview and report list device-local URLs (`127.0.0.1` / `localhost`), LAN-private URLs (`192.168.x.x` …), absolute paths that do not exist here, and commands embedding source-machine paths — with field names like `models.providers.magpie.baseUrl` so you can fix them quickly.
- The full rebase/warning plan is shown **before** you confirm the restore; what you see is exactly what gets applied (the archive is staged and inspected first, nothing touches your agent dir before confirmation).
- Legacy archives without a manifest restore verbatim, with a warning to review paths manually. A malformed manifest fails the inspection instead of being silently ignored.

Unknown plugin-config files from the allowlist are never rewritten — only scanned and reported.

### Backup filename

Archives look like:

```text
pi_sync_backup_2026-07-14_20260714120000_windows11.tar.gz
```

The trailing platform tag (`windows11` / `windows10` / `macos` / `linux`) shows which host created the backup.

### Safety on restore

- The archive is extracted to a staging directory first, inspected (entry validation, no symlinks, manifest, path rebases), and the full plan is shown before anything is written
- Existing config files get a timestamped `.bak` copy before overwrite
- Existing skills / extensions folders are renamed to `*-backup-<timestamp>` before replace/merge
- Restore shows a plan (including path portability) and asks for confirmation
- After a successful restore you can reload the agent runtime to apply skills/extensions

## Bootstrap (new Windows machine, no Pi yet)

If Pi is not installed yet, you can still pull the latest zip with the helper script:

```powershell
# Prefer env vars so secrets never land in shell history
$env:PI_WEBDAV_URL  = "https://your-webdav.example/dav/Pi"
$env:PI_WEBDAV_USER = "your-user"
$env:PI_WEBDAV_PASS = "your-app-password"
.\pi-bootstrap.ps1
```

Or one-liner placeholders (replace before running):

```powershell
$url="https://your-webdav.example/dav/Pi"; $user="your-user"; $pass="your-app-password"
$pair="$user`:$pass"; $auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$resp=Invoke-RestMethod -Uri $url -Method PROPFIND -Headers @{Authorization="Basic $auth";Depth="1"} -ContentType "application/xml"
$files=([regex]'<d:href>([^<]+)</d:href>').Matches($resp) | %{$_.Groups[1].Value} | ?{$_ -match "pi_sync_backup_.*\.(tar\.gz|zip)$"} | Sort-Object -Descending
$latest=$files[0]; $name=Split-Path $latest -Leaf
Invoke-WebRequest -Uri "$url/$name" -Headers @{Authorization="Basic $auth"} -OutFile "$env:TEMP\$name"
```

Then install Pi and use **Download Backup** from `/sync` for future updates.

## Security

- WebDAV credentials are stored locally in `~/.pi/agent/sync_config.json`
- Prefer **app-specific passwords** (not your main account password)
- Prefer env-var references: set password to `$PI_WEBDAV_PASS` in the UI, then export that variable in your shell profile
- Backups may include `auth.json` / API keys if those options are enabled — treat the WebDAV folder as sensitive
- Never commit real WebDAV URLs with credentials into git

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| HTTP 401 / 403 | Check user/password; use app password; confirm URL includes the correct DAV path |
| PROPFIND fails / empty list | Server may block PROPFIND; try another WebDAV provider; ensure Depth:1 is allowed |
| tar / zip errors | Need a working `tar` on PATH (Windows 10+ has one; Git Bash / WSL also fine) |
| Restore overwrote something | Look for `*.bak-*` files and `skills-backup-*` / `extensions-backup-*` folders next to the agent dir |
| Plugin missing after restore | Re-run `pi install git:github.com/BevalZ/pi-sync` — the sync package excludes itself from the archive |

## Structure

```text
pi-sync/
  package.json
  LICENSE
  README.md
  README.zh-CN.md
  pi-bootstrap.ps1
  docs/
    sync-menu.png       # /sync menu screenshot
  extensions/
    sync/
      index.ts          # /sync command
    _shared/
      json-io.ts
      enhanced-select.ts
      spawn.ts
      fetch-utils.ts
      box-drawing.ts
```

## Changelog

### v1.4.0

- **Cross-system path portability**: backups carry a `manifest.json` (source home/agent dir/platform). On restore, absolute paths in known fields (`settings.json` resources, `sessionDir`, `shellPath`, `mcp.json` command/cwd/args) are rebased to this machine — Linux↔Windows included. Everything else is report-only with precise field names
- **Restore preview before apply**: the archive is staged and inspected first; the confirm dialog shows the exact rebase plan (from → to, exists here?) plus warnings for device-local (`127.0.0.1`) and LAN-private (`192.168.x.x`) URLs, missing paths, and commands embedding source paths
- **`mcp.json` is now synced** as a core config file; `mcp-auth.json` stays opt-in
- **Extra config files (allowlist)**: sync plugin configs from the agent dir root (`pi-fff.json`, `open-tui.json`, …) — explicit opt-in via Configure Active Profile, with a discovery menu. `sync_config.json` is hard-excluded
- **Security hardening**: archive validation tightened (flat `config/<name>.json` only, reserved names rejected, case-collision checks, symlink rejection after staging)
- **`PI_CODING_AGENT_DIR` support**: packing, restore, and the sync config itself now respect Pi's agent-dir override
- `settings.packages` diff handles the object form `{ source, … }`
- Tests: 64 path-portability + 24 archive-validation + 36 end-to-end cases (real extension driven through a mock WebDAV server) — `npm test`

### v1.3.8

- Smoother menu navigation: the main `/sync` menu now loops, so returning from a submenu lands back on the main menu instead of dropping to chat. Only Exit / Esc leaves.

### v1.3.7

- **Pure-JS ZIP extract** for legacy Windows `.zip` backups (no GNU tar / unzip required on Linux)
- Detect ZIP by magic bytes (`PK`), not only by extension
- Prefer re-uploading as `.tar.gz` (v1.3.6+) for new backups

### v1.3.6

- Archives are now **`.tar.gz`** (gzip) instead of `.zip` so Windows → Linux restore works with stock GNU tar
- Restore still accepts **legacy `.zip`** when `tar -a`, plain `tar`, `unzip`, or PowerShell Expand-Archive is available
- List/filter backups includes `.tar.gz` / `.tgz` / `.zip`

### v1.3.5

- Hard fix for **Maximum call stack size exceeded** on restore:
  - rename `errMsg` → non-recursive `formatError`
  - replace recursive `copyRecursiveSync` with `fs.cpSync` / iterative stack
  - top-level `/sync` handler try/catch so failures surface as UI errors

### v1.3.4

- Fix **Maximum call stack size exceeded** on restore/list: `errMsg` was recursively calling itself

### v1.3.3

- Backup filenames use **zero-padded dates** (`2026-07-04` not `2026-7-4`)
- Cloud backup list sorted by **14-digit timestamp** (newest first); legacy unpadded names still sort correctly
- Restore accepts tar entries like `./` / `./config/...` (no longer fails with `Unexpected top-level archive entry rejected: ./`)

### v1.3.2

- Code quality: shared WebDAV auth helper, backup-name parser, unified `errMsg`, clock-skew reset helper
- Minor cleanup without UI/behavior changes

### v1.3.1

- **Multi-profile upload**: pack once, upload the same archive to several ready profiles
- Download can **pick source profile** without permanently switching active
- Clearer main menu (active upload vs multi upload); per-target success/fail summary
- Docs: multi-profile workflow + example config

### v1.3.0

- **Multiple sync profiles**: switch between WebDAV / S3 (or several of each) without re-entering settings
- Main menu: Switch Profile · Manage Profiles (add / duplicate / delete / rename)
- `sync_config.json` v2 format with `activeProfile` + `profiles`; legacy flat files auto-migrate
- Example multi-profile template: `docs/sync_config.example.json`

### v1.2.1

- Auto-correct **clock skew** for S3/R2 SigV4 (`RequestTimeTooSkewed`): learn server `Date` and re-sign once

### v1.2.0

- **S3-compatible backend**: Amazon S3, MinIO, Cloudflare R2, and other SigV4 gateways (no AWS SDK dependency)
- Setup wizard and Configure menu support switching **WebDAV ↔ S3**
- Object prefix + path-style options; credentials support `$ENV_VAR`
- Unit + local mock-server tests (`npm test` / `node scripts/s3-test.mjs`)

### v1.1.0

- **tar preflight** before Upload/Download (PATH + `tar -a` zip create probe)
- **Restore report** after success: restored items, local safety-backup paths, `settings.packages` diff
- Post-restore hints for device-local providers / provider-proxy

### v1.0.1

- Tag backup zip names with host platform (`windows11` / `macos` / `linux` / …)
- Remove example credentials from bootstrap script comments
- Add MIT `LICENSE` and expand README (security, restore safety, troubleshooting, menu screenshot)

### v1.0.0

- Initial public release: interactive `/sync` menu over WebDAV
  - Upload Backup · Download Backup · Configure Active Profile
- Windows bootstrap helper script

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

This open-source project is linked and recognized by the [LINUX DO](https://linux.do) community.
