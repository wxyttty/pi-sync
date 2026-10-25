# pi-sync

[English](./README.md) | **简体中文**

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![release](https://img.shields.io/github/v/release/BevalZ/pi-sync?display_name=tag&sort=semver)](https://github.com/BevalZ/pi-sync/releases)

面向 [Pi](https://github.com/earendil-works/pi-coding-agent) 的 WebDAV 配置同步工具 —— 跨机器备份与恢复 **models**、**settings**、**skills**、**extensions**。

在 Pi 里输入 `/sync`，从菜单选择操作。一台机器上传，另一台下载并恢复。

<p align="center">
  <img src="docs/sync-menu.png" alt="Pi WebDAV Synchronization 菜单" width="720" />
</p>

<p align="center"><sub><b>Pi WebDAV Synchronization</b> —— 输入 <code>/sync</code> 后的交互菜单</sub></p>

## 为什么需要它

如果你在多台 PC / WSL / 服务器上使用 Pi，手工重装 models、skills、extensions 很痛苦。`pi-sync` 会把 agent 主目录打包成带时间戳的 zip，上传到任意 WebDAV 目录，并在恢复时保留本地安全备份。

## 安装

需要 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)，以及可用的 WebDAV（TeraCLOUD、坚果云、Nextcloud、ownCloud、自建等）。

```bash
pi install git:github.com/BevalZ/pi-sync@v1.4.1
```

然后重启 Pi，或执行 `/reload`。

## 用法

在 Pi 中输入 **`/sync`**。没有命令行子命令 —— 全部通过交互菜单完成：

| 菜单项 | 作用 |
|--------|------|
| ☁️ **Upload Backup (Backup to cloud)** | 打包当前配置并上传到 WebDAV |
| 📥 **Download Backup (Restore from cloud)** | 列出云端备份，下载并在确认后恢复 |
| ⚙️ **Configure Sync Settings** | 配置 WebDAV 地址 / 用户 / 密码，以及同步范围 |
| ❌ **Cancel** | 退出菜单 |

TUI 提示：`↵` 选择 · `↑↓` 导航 · `Esc` 取消。

### 首次配置

```bash
# 1. 安装
pi install git:github.com/BevalZ/pi-sync@v1.4.1

# 2. 打开菜单（若尚未配置 WebDAV，会先进入设置向导）
/sync

# 3. 如需修改：Configure Sync Settings
#    填写 URL / 用户名 / 密码
#    建议：密码填 $PI_WEBDAV_PASS，并在 shell 中 export 该环境变量

# 4. 主力机 → Upload Backup (Backup to cloud)
# 5. 新机器（安装并配置后）→ Download Backup (Restore from cloud)
```

### 会同步哪些内容

| 组件 | 默认 | 说明 |
|------|------|------|
| Config | 开 | `models.json`、`settings.json`、`auth.json`、`mcp.json` |
| 额外配置文件 | 关（白名单） | agent 目录根下的插件配置，如 `pi-fff.json` —— 在 **Configure Active Profile → Extra config files** 中挑选 |
| Agent 配置 | 开 | `~/.pi/web-search.json`、`<agent-dir>/AGENTS.md`、`<agent-dir>/pi-blackhole/pi-blackhole-config.json`（归档目录 `agent-config/`） |
| Skills | 开 | 整个 `~/.pi/agent/skills` |
| Extensions | 开 | `~/.pi/agent/extensions`（zip 中会排除 sync 插件自身） |

`sync_config.json`（云端凭证）永远不会被打包或恢复。`mcp-auth.json`（OAuth 授权）默认不同步 —— 发现菜单中已排除，只能手动加入白名单；且恢复端同样校验授权：归档里未经本机 profile 授权的配置文件只会列为"跳过"，绝不写入。

可在 **Configure Sync Settings** 中分别开关。

### 跨系统路径适配

v1.4.0+ 生成的备份带有 `manifest.json`，记录源主机的 home 与 agent 目录。恢复时：

- **已知路径字段**（`settings.json` 的 `extensions` / `skills` / `prompts` / `themes` 资源、`sessionDir`、`shellPath`，以及 `mcp.json` 的 `command` / `cwd` / 整路径 `args`）中的绝对路径会被**重定位**到本机 home —— `/home/alice/…` → `/home/bob/…`，`C:\Users\wxy\…` → `/home/bob/…`，并自动转换分隔符。指向源 agent 目录内部的路径会重定位到本机 agent 目录（同样支持 `PI_CODING_AGENT_DIR`）。
- 资源控制前缀（`!`、`+`、`-`）与非路径条目（`npm:…`、`git:…`、`builtin:…`、URL）原样保留。
- 其余内容**只报告不改写**：恢复预览与报告会列出本机回环地址（`127.0.0.1` / `localhost`）、局域网地址（`192.168.x.x` 等）、本机不存在的绝对路径、以及内嵌源机器路径的命令 —— 附带 `models.providers.magpie.baseUrl` 这样的字段名，便于快速修复。
- 完整的重定位/警告计划会在**确认恢复之前**展示；所见即所改（归档先解压到暂存区检查，确认前不会写入 agent 目录）。
- 配置文件只有**本机 profile 授权**（核心文件 + 本机白名单）才会恢复；归档中未授权的文件会列为"跳过"，绝不写入。
- 无 manifest 的旧版归档按原样恢复，并提示手动检查路径。manifest 损坏会让检查直接失败，而不是被静默忽略。
- 诊断信息会脱敏（URL 查询串截断），报告里不会出现 URL 中的 API key。

白名单中的未知插件配置文件永远不会被改写 —— 只扫描、只报告。

### 备份文件名

归档文件形如：

```text
pi_sync_backup_2026-07-14_20260714120000_windows11.zip
```

末尾的平台标签（`windows11` / `windows10` / `macos` / `linux`）标明该备份由哪类主机生成。

### 恢复时的安全机制

- 解压前先做成员类型校验：tar 成员必须是普通文件/目录，符号链接/硬链接/设备成员在解压前即被拒绝
- 归档解压到暂存目录后再次检查（暂存树内不得有符号链接），完整计划展示后才写入任何文件
- 覆盖前，已有配置文件会生成带时间戳的 `.bak` 副本
- 已有 skills / extensions 目录会先改名为 `*-backup-<timestamp>`，再替换/合并
- 恢复前会展示计划（含路径适配），并要求确认
- 恢复成功后可选择 reload agent runtime，以应用 skills / extensions

## 新机引导（Windows，尚未安装 Pi）

若还没装 Pi，也可先用辅助脚本拉取最新 zip：

```powershell
# 优先用环境变量，避免密钥进入 shell 历史
$env:PI_WEBDAV_URL  = "https://your-webdav.example/dav/Pi"
$env:PI_WEBDAV_USER = "your-user"
$env:PI_WEBDAV_PASS = "your-app-password"
.\pi-bootstrap.ps1
```

或使用占位符一行命令（运行前请替换）：

```powershell
$url="https://your-webdav.example/dav/Pi"; $user="your-user"; $pass="your-app-password"
$pair="$user`:$pass"; $auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$resp=Invoke-RestMethod -Uri $url -Method PROPFIND -Headers @{Authorization="Basic $auth";Depth="1"} -ContentType "application/xml"
$files=([regex]'<d:href>([^<]+)</d:href>').Matches($resp) | %{$_.Groups[1].Value} | ?{$_ -match "pi_sync_backup_.*\.zip$"} | Sort-Object -Descending
$latest=$files[0]; $name=Split-Path $latest -Leaf
Invoke-WebRequest -Uri "$url/$name" -Headers @{Authorization="Basic $auth"} -OutFile "$env:TEMP\$name"
```

之后安装 Pi，后续更新用 `/sync` → **Download Backup** 即可。

## 安全建议

- WebDAV 凭证保存在本机 `~/.pi/agent/sync_config.json`
- 优先使用**应用专用密码**（不要用主账号密码）
- 更推荐环境变量引用：界面里密码填 `$PI_WEBDAV_PASS`，再在 shell profile 中 export
- 若开启相关选项，备份可能包含 `auth.json` / API key —— 请把 WebDAV 目录当敏感数据对待
- 切勿把真实 WebDAV 地址与凭证提交进 git

## 故障排查

| 现象 | 处理 |
|------|------|
| HTTP 401 / 403 | 检查用户名密码；改用应用专用密码；确认 URL 含正确 DAV 路径 |
| PROPFIND 失败 / 列表为空 | 服务端可能禁用 PROPFIND；换 WebDAV 提供商；确认允许 Depth:1 |
| tar / zip 报错 | PATH 中需要可用的 `tar`（Windows 10+ 自带；Git Bash / WSL 亦可） |
| 恢复覆盖了本地内容 | 在 agent 目录旁查找 `*.bak-*` 与 `skills-backup-*` / `extensions-backup-*` |
| 恢复后插件不见了 | 重新执行 `pi install git:github.com/BevalZ/pi-sync` —— 归档会排除 sync 包自身 |

## 目录结构

```text
pi-sync/
  package.json
  LICENSE
  README.md
  README.zh-CN.md
  pi-bootstrap.ps1
  docs/
    sync-menu.png       # /sync 菜单截图
  extensions/
    sync/
      index.ts          # /sync 命令
    _shared/
      json-io.ts
      enhanced-select.ts
      spawn.ts
      fetch-utils.ts
      box-drawing.ts
```

# pi-sync

[English](./README.md) | **简体中文**

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![release](https://img.shields.io/github/v/release/BevalZ/pi-sync?display_name=tag&sort=semver)](https://github.com/BevalZ/pi-sync/releases)

面向 [Pi](https://github.com/earendil-works/pi-coding-agent) 的 WebDAV 配置同步工具 —— 跨机器备份与恢复 **models**、**settings**、**skills**、**extensions**。

在 Pi 里输入 `/sync`，从菜单选择操作。一台机器上传，另一台下载并恢复。

<p align="center">
  <img src="docs/sync-menu.png" alt="Pi WebDAV Synchronization 菜单" width="720" />
</p>

<p align="center"><sub><b>Pi WebDAV Synchronization</b> —— 输入 <code>/sync</code> 后的交互菜单</sub></p>

## 为什么需要它

如果你在多台 PC / WSL / 服务器上使用 Pi，手工重装 models、skills、extensions 很痛苦。`pi-sync` 会把 agent 主目录打包成带时间戳的 zip，上传到任意 WebDAV 目录，并在恢复时保留本地安全备份。

## 安装

需要 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)，以及可用的 WebDAV（TeraCLOUD、坚果云、Nextcloud、ownCloud、自建等）。

```bash
pi install git:github.com/BevalZ/pi-sync@v1.4.1
```

然后重启 Pi，或执行 `/reload`。

## 用法

在 Pi 中输入 **`/sync`**。没有命令行子命令 —— 全部通过交互菜单完成：

| 菜单项 | 作用 |
|--------|------|
| ☁️ **Upload Backup (Backup to cloud)** | 打包当前配置并上传到 WebDAV |
| 📥 **Download Backup (Restore from cloud)** | 列出云端备份，下载并在确认后恢复 |
| ⚙️ **Configure Sync Settings** | 配置 WebDAV 地址 / 用户 / 密码，以及同步范围 |
| ❌ **Cancel** | 退出菜单 |

TUI 提示：`↵` 选择 · `↑↓` 导航 · `Esc` 取消。

### 首次配置

```bash
# 1. 安装
pi install git:github.com/BevalZ/pi-sync@v1.4.1

# 2. 打开菜单（若尚未配置 WebDAV，会先进入设置向导）
/sync

# 3. 如需修改：Configure Sync Settings
#    填写 URL / 用户名 / 密码
#    建议：密码填 $PI_WEBDAV_PASS，并在 shell 中 export 该环境变量

# 4. 主力机 → Upload Backup (Backup to cloud)
# 5. 新机器（安装并配置后）→ Download Backup (Restore from cloud)
```

### 会同步哪些内容

| 组件 | 默认 | 说明 |
|------|------|------|
| Config | 开 | `models.json`、`settings.json`、`auth.json`、`mcp.json` |
| 额外配置文件 | 关（白名单） | agent 目录根下的插件配置，如 `pi-fff.json` —— 在 **Configure Active Profile → Extra config files** 中挑选 |
| Agent 配置 | 开 | `~/.pi/web-search.json`、`<agent-dir>/AGENTS.md`、`<agent-dir>/pi-blackhole/pi-blackhole-config.json`（归档目录 `agent-config/`） |
| Skills | 开 | 整个 `~/.pi/agent/skills` |
| Extensions | 开 | `~/.pi/agent/extensions`（zip 中会排除 sync 插件自身） |

`sync_config.json`（云端凭证）永远不会被打包或恢复。`mcp-auth.json`（OAuth 授权）默认不同步 —— 发现菜单中已排除，只能手动加入白名单；且恢复端同样校验授权：归档里未经本机 profile 授权的配置文件只会列为"跳过"，绝不写入。

可在 **Configure Sync Settings** 中分别开关。

### 跨系统路径适配

v1.4.0+ 生成的备份带有 `manifest.json`，记录源主机的 home 与 agent 目录。恢复时：

- **已知路径字段**（`settings.json` 的 `extensions` / `skills` / `prompts` / `themes` 资源、`sessionDir`、`shellPath`，以及 `mcp.json` 的 `command` / `cwd` / 整路径 `args`）中的绝对路径会被**重定位**到本机 home —— `/home/alice/…` → `/home/bob/…`，`C:\Users\wxy\…` → `/home/bob/…`，并自动转换分隔符。指向源 agent 目录内部的路径会重定位到本机 agent 目录（同样支持 `PI_CODING_AGENT_DIR`）。
- 资源控制前缀（`!`、`+`、`-`）与非路径条目（`npm:…`、`git:…`、`builtin:…`、URL）原样保留。
- 其余内容**只报告不改写**：恢复预览与报告会列出本机回环地址（`127.0.0.1` / `localhost`）、局域网地址（`192.168.x.x` 等）、本机不存在的绝对路径、以及内嵌源机器路径的命令 —— 附带 `models.providers.magpie.baseUrl` 这样的字段名，便于快速修复。
- 完整的重定位/警告计划会在**确认恢复之前**展示；所见即所改（归档先解压到暂存区检查，确认前不会写入 agent 目录）。
- 配置文件只有**本机 profile 授权**（核心文件 + 本机白名单）才会恢复；归档中未授权的文件会列为"跳过"，绝不写入。
- 无 manifest 的旧版归档按原样恢复，并提示手动检查路径。manifest 损坏会让检查直接失败，而不是被静默忽略。
- 诊断信息会脱敏（URL 查询串截断），报告里不会出现 URL 中的 API key。

白名单中的未知插件配置文件永远不会被改写 —— 只扫描、只报告。

### 备份文件名

归档文件形如：

```text
pi_sync_backup_2026-07-14_20260714120000_windows11.zip
```

末尾的平台标签（`windows11` / `windows10` / `macos` / `linux`）标明该备份由哪类主机生成。

### 恢复时的安全机制

- 解压前先做成员类型校验：tar 成员必须是普通文件/目录，符号链接/硬链接/设备成员在解压前即被拒绝
- 归档解压到暂存目录后再次检查（暂存树内不得有符号链接），完整计划展示后才写入任何文件
- 覆盖前，已有配置文件会生成带时间戳的 `.bak` 副本
- 已有 skills / extensions 目录会先改名为 `*-backup-<timestamp>`，再替换/合并
- 恢复前会展示计划（含路径适配），并要求确认
- 恢复成功后可选择 reload agent runtime，以应用 skills / extensions

## 新机引导（Windows，尚未安装 Pi）

若还没装 Pi，也可先用辅助脚本拉取最新 zip：

```powershell
# 优先用环境变量，避免密钥进入 shell 历史
$env:PI_WEBDAV_URL  = "https://your-webdav.example/dav/Pi"
$env:PI_WEBDAV_USER = "your-user"
$env:PI_WEBDAV_PASS = "your-app-password"
.\pi-bootstrap.ps1
```

或使用占位符一行命令（运行前请替换）：

```powershell
$url="https://your-webdav.example/dav/Pi"; $user="your-user"; $pass="your-app-password"
$pair="$user`:$pass"; $auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$resp=Invoke-RestMethod -Uri $url -Method PROPFIND -Headers @{Authorization="Basic $auth";Depth="1"} -ContentType "application/xml"
$files=([regex]'<d:href>([^<]+)</d:href>').Matches($resp) | %{$_.Groups[1].Value} | ?{$_ -match "pi_sync_backup_.*\.zip$"} | Sort-Object -Descending
$latest=$files[0]; $name=Split-Path $latest -Leaf
Invoke-WebRequest -Uri "$url/$name" -Headers @{Authorization="Basic $auth"} -OutFile "$env:TEMP\$name"
```

之后安装 Pi，后续更新用 `/sync` → **Download Backup** 即可。

## 安全建议

- WebDAV 凭证保存在本机 `~/.pi/agent/sync_config.json`
- 优先使用**应用专用密码**（不要用主账号密码）
- 更推荐环境变量引用：界面里密码填 `$PI_WEBDAV_PASS`，再在 shell profile 中 export
- 若开启相关选项，备份可能包含 `auth.json` / API key —— 请把 WebDAV 目录当敏感数据对待
- 切勿把真实 WebDAV 地址与凭证提交进 git

## 故障排查

| 现象 | 处理 |
|------|------|
| HTTP 401 / 403 | 检查用户名密码；改用应用专用密码；确认 URL 含正确 DAV 路径 |
| PROPFIND 失败 / 列表为空 | 服务端可能禁用 PROPFIND；换 WebDAV 提供商；确认允许 Depth:1 |
| tar / zip 报错 | PATH 中需要可用的 `tar`（Windows 10+ 自带；Git Bash / WSL 亦可） |
| 恢复覆盖了本地内容 | 在 agent 目录旁查找 `*.bak-*` 与 `skills-backup-*` / `extensions-backup-*` |
| 恢复后插件不见了 | 重新执行 `pi install git:github.com/BevalZ/pi-sync` —— 归档会排除 sync 包自身 |

## 目录结构

```text
pi-sync/
  package.json
  LICENSE
  README.md
  README.zh-CN.md
  pi-bootstrap.ps1
  docs/
    sync-menu.png       # /sync 菜单截图
  extensions/
    sync/
      index.ts          # /sync 命令
    _shared/
      json-io.ts
      enhanced-select.ts
      spawn.ts
      fetch-utils.ts
      box-drawing.ts
```

## 更新日志

### v1.4.1

- **恢复端执行白名单授权**：归档中的配置文件只有本机 profile 授权（核心 + 白名单）才会恢复；未授权文件列为"跳过"
- **解压前成员类型校验**：非普通文件/目录的 tar 成员（符号链接/硬链接/设备）在解压前拒绝；ZIP 安全拒绝不再回退到外部解压器；目标文件为符号链接时替换链接本身，目标目录为符号链接时中止恢复
- **路径语义加固**：Windows 盘根、重复/尾部分隔符、POSIX 字面反斜杠；`externalEditor` 仅在纯路径时重定位（带参数的命令只报告）；manifest 必须携带绝对源路径
- **只报告扫描修复**：标量数组叶子纳入扫描（`{"paths": ["/home/…"]}` 会告警）；已重定位字段不再重复告警；诊断中 URL 查询串脱敏
- **Agent 配置备份**（来自 master）：`~/.pi/web-search.json`、`AGENTS.md`、`pi-blackhole/pi-blackhole-config.json` 归入 `agent-config/`，开关 **Backup Agent Config**；兼容旧版 `agent-config/agent/mcp.json` 归档
- 测试：89 路径 + 29 归档 + 56 端到端（含对抗性符号链接归档、未授权文件跳过、取消后一切不变）

### v1.4.0

- **跨系统路径适配**：备份携带 `manifest.json`（源 home / agent 目录 / 平台）。恢复时，已知字段中的绝对路径（`settings.json` 资源、`sessionDir`、`shellPath`、`mcp.json` command/cwd/args）重定位到本机 —— 支持 Linux↔Windows。其余内容只报告，附精确字段名
- **先预览后应用**：归档先暂存检查；确认对话框展示完整重定位计划（from → to，本机是否存在）以及本机回环（`127.0.0.1`）、局域网（`192.168.x.x`）URL、缺失路径、内嵌源路径命令的警告
- **`mcp.json` 纳入核心配置**同步；`mcp-auth.json` 保持可选
- **额外配置文件白名单**：同步 agent 目录根下的插件配置（`pi-fff.json`、`open-tui.json` 等）—— 通过 Configure Active Profile 显式开启，带发现菜单。`sync_config.json` 硬排除
- **安全加固**：归档校验收紧（仅平铺 `config/<name>.json`、保留名拒绝、大小写冲突检查、暂存后拒绝符号链接）
- **支持 `PI_CODING_AGENT_DIR`**：打包、恢复与 sync 配置本身均遵循 Pi 的 agent 目录覆盖
- `settings.packages` 差异报告支持对象形式 `{ source, … }`
- 测试：64 个路径适配 + 24 个归档校验 + 36 个端到端用例（通过 mock WebDAV 服务器驱动真实插件）—— `npm test`

### v1.3.8

- 菜单导航更顺滑：主菜单 `/sync` 现在会循环，从子菜单返回时回到主菜单而不是掉回聊天。只有 Exit / Esc 才退出。

### v1.3.7

- **纯 JS 解压 ZIP**：旧版 Windows `.zip` 备份在 Linux 上无需 GNU tar/`unzip` 即可恢复
- 按文件魔数识别 ZIP（不单靠扩展名）
- 新备份仍建议用 v1.3.6+ 的 **`.tar.gz`**

### v1.3.6

- 备份格式改为 **`.tar.gz`**（跨平台），避免 Windows 打的 zip 在 Linux GNU tar 上无法解压
- 仍可恢复旧 **`.tar.gz`**（需系统 tar/`unzip`/PowerShell 支持）
- 备份列表识别 `.tar.gz` / `.tgz` / `.tar.gz`

### v1.3.5

- 加固修复恢复时 **Maximum call stack size exceeded**：
  - `errMsg` 重命名为非递归 `formatError`
  - 递归目录复制改为 `fs.cpSync` / 迭代栈
  - `/sync` 入口增加 try/catch，错误以通知显示而非插件崩溃

### v1.3.4

- 修复拉取/恢复时 **Maximum call stack size exceeded**：`errMsg` 误写成递归自调用

### v1.3.3

- 备份文件名日期**补零**（`2026-07-04`，不再是 `2026-7-4`）
- 云端备份列表按 **14 位时间戳** 新→旧排序；旧的未补零文件名也能正确排序
- 恢复时接受 `./` / `./config/...` 等 tar 条目（修复 `Unexpected top-level archive entry rejected: ./`）

### v1.3.2

- 代码质量：WebDAV 鉴权/备份名解析抽取、`errMsg` 统一、时钟偏差 reset 辅助函数
- 无功能/UI 行为变更的梳理精简

### v1.3.1

- **多配置同时上传**：打一次包，同一 zip 推到多个已就绪 profile
- 下载时可**选择源 profile**（不必永久切换 active）
- 主菜单区分「当前上传」与「多目标上传」；分目标成功/失败汇总
- 文档补充多配置流程与示例

### v1.3.0

- **多配置 Profile**：可在多个 WebDAV / S3 目标间切换，无需反复改配置
- 主菜单：切换 Profile · 管理 Profile（新增 / 复制 / 删除 / 重命名）
- `sync_config.json` v2：`activeProfile` + `profiles`；旧版扁平配置自动迁移
- 多配置示例：`docs/sync_config.example.json`

### v1.2.1

- S3/R2 SigV4 **时钟偏差自动校正**（`RequestTimeTooSkewed`）：学习服务端 `Date` 并重签一次

### v1.2.0

- **S3 兼容后端**：Amazon S3 / MinIO / Cloudflare R2 等（无 AWS SDK 依赖，SigV4）
- 安装向导与配置菜单支持 **WebDAV ↔ S3** 切换
- 对象前缀、path-style；密钥支持 `$ENV_VAR`
- 单元测试 + 本地 mock S3（`npm test`）

### v1.1.0

- Upload/Download 前 **tar 预检**（检测 PATH 上的 tar 与 `tar -a` 打 zip 能力）
- Restore 成功后输出 **差异报告**：恢复项、本地 safety backup 路径、`settings.packages` 增减
- 恢复提示中补充 device-local provider / provider-proxy 注意点

### v1.0.1

- 备份 zip 文件名增加主机平台标签（`windows11` / `macos` / `linux` 等）
- 从 bootstrap 脚本示例中移除真实凭证
- 增加 MIT `LICENSE`，扩充 README（安全、恢复保护、故障排查、菜单截图）

### v1.0.0

- 首次公开发布：基于 WebDAV / S3 的交互式 `/sync` 菜单
  - Upload Backup · Download Backup · Configure Sync Settings
- Windows 新机引导脚本

## 许可证

MIT — 见 [LICENSE](./LICENSE)。

## 致谢

本开源项目已链接并获 [LINUX DO](https://linux.do) 社区认可。


- 备份 zip 文件名增加主机平台标签（`windows11` / `macos` / `linux` 等）
- 从 bootstrap 脚本示例中移除真实凭证
- 增加 MIT `LICENSE`，扩充 README（安全、恢复保护、故障排查、菜单截图）

### v1.0.0

- 首次公开发布：基于 WebDAV 的交互式 `/sync` 菜单
  - Upload Backup · Download Backup · Configure Sync Settings
- Windows 新机引导脚本

## 许可证

MIT — 见 [LICENSE](./LICENSE)。

## 致谢

本开源项目已链接并获 [LINUX DO](https://linux.do) 社区认可。
