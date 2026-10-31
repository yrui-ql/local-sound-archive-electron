# LSA · 留声

**中文** | [English](#english)

A local-first music archive and player for Windows and macOS.

![LSA desktop](docs/library.png)

---

## 中文

### 简介

LSA / 留声是一个本地优先的音乐归档与播放器。它扫描你的本地音乐目录，提供播放、歌词、搜索下载、喜欢同步、扩展和本地 AI 控制，不依赖网页播放器，也不把音乐上传到云端。

桌面端基于 Electron，复用原有 HTML/CSS/JS 界面；主进程负责文件系统、SQLite、本地音频服务、AI/MCP 和平台集成。

### 功能

| 模块 | 能力 |
|---|---|
| 本地音乐库 | 多目录扫描、SQLite 索引、下载来源记录、格式筛选、搜索、分页加载 |
| 播放 | FLAC / MP3 / M4A / WAV / OGG，Range 音频服务，播放队列，定位当前播放，最近记录可配置上限 |
| 歌词 | 本地 `.lrc` 加载与滚动高亮 |
| 在线服务 | 本机 `go-music-dl` 代理搜索、下载队列与任务操作 |
| 账号 | 网易云 / QQ 扫码登录，汽水客户端 Cookie 读取 |
| 喜欢同步 | 同步配置、状态、失败任务清理 |
| 扩展 | 扩展安装/启用/禁用/移除、来源自动注册、扩展音源搜索、本地下载入库、扩展任务调度、扩展 SDK |
| AI 控制 | localhost HTTP API + MCP，端口可配置，占用时自动顺延 |
| 录音 | 系统声音录制、试听、删除、分页列表 |
| 桌面体验 | 单实例唤醒、Windows 托盘、无边框窗口、主题、界面比例 |
| 主题 | 黑胶、纸页、青瓷、青绿、夜蓝、樱桃、跟随系统 |

### 下载与安装

Windows 便携版：

```text
release/LSA-portable/LSA.exe
```

macOS 使用 unsigned DMG/zip。首次打开需要在 Finder 中右键 → 打开，或按系统提示允许。

> macOS 包未签名、未公证，也不上架 App Store。项目尚未在真实 Mac 硬件上完成安装冒烟测试。

### 开发

要求 Node.js 22+。

```bash
npm ci
npm test   # 核心单元测试
npm start
```

可选环境变量：

```text
LSA_MUSIC_DIR       音乐库目录，多个目录用系统路径分隔符
LSA_DATA_DIR        本地数据目录
LSA_BACKEND_URL     go-music-dl 地址，默认 http://127.0.0.1:18088
```

### 配置

- `config/default.json`：公共默认值，不含个人路径；
- `config/local.example.json`：带占位符的本地配置示例；
- 本地数据目录的 `config.json`：个人音乐目录、后端地址等；
- 本地数据目录的 `admin-credentials.txt`：本机后端凭据，不进入仓库。

### 构建

Windows：

```bash
npm run package:win
```

macOS：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac
```

macOS 使用 `build/entitlements.mac.plist` 的 hardened runtime 配置。正式签名/公证需要自备 Apple Developer 凭据。

### 在线服务

搜索、扫码登录和下载依赖本机运行的 `go-music-dl` 服务，默认监听 `127.0.0.1:18088`。应用不内置这个服务。

### 外部音源扩展

YouTube Music 通过 `extension-sdk/examples/youtube-music` 作为可选扩展接入，搜索与下载使用本机 `yt-dlp`。汽水音乐通过 `extension-sdk/examples/soda` 接入，登录、搜索、下载入队和喜欢同步都走扩展能力。

```text
<data>/tools/yt-dlp.exe      # Windows
<data>/tools/yt-dlp          # macOS / Linux
```

在「设置 → 扩展 → 从文件夹安装」选择扩展目录即可。扩展可随时禁用或移除，不影响核心客户端。

### AI 控制

在设置中开启 AI control 后，应用会在 localhost 启动控制服务并提供 MCP 配置。默认端口 `18765`，可修改；被占用时自动选择下一个可用端口。令牌保存在本地数据目录。

### 项目结构

```text
src/main/index.js       主进程入口、窗口与 IPC 编排
src/main/services/      主进程领域服务
src/preload/index.js    contextBridge 窄接口
ui/                     渲染层资源
ai-control/             本地 AI 控制协议与 MCP bridge
extension-sdk/          扩展契约、样例与文档
scripts/                构建、便携打包、喜欢同步、启动器
config/                 公共默认配置与 vendor 审计锚点
docs/                   架构、工作流、ADR 与截图
```

更多文档：

- [架构](docs/architecture.md)
- [工程工作流](docs/engineering-workflow.md)
- [测试策略](docs/testing.md)
- [开源项目参考架构](docs/reference-architectures.md)
- [功能交付清单](docs/checklists/feature-delivery.md)
- [UI 交付门禁](docs/checklists/ui-delivery.md)

### 发布审计

项目源码、配置、README 和启动器必须通过 `privacy-audit`。官方 Electron 运行时通过 SHA256 固定的 vendor allowlist 处理；它不是用户数据，也不能用破坏二进制的方式绕过审计。

### License

MIT

---

## English

### Overview

LSA is a local-first music archive and player for Windows and macOS. It scans local folders and provides playback, lyrics, search/download, likes sync, extensions and local AI control. It does not depend on a web player and does not upload your library to the cloud.

The desktop app is built on Electron and reuses the existing HTML/CSS/JS renderer. The main process owns filesystem access, SQLite, the local audio server, AI/MCP and platform integration.

### Features

| Area | Capability |
|---|---|
| Library | multi-folder scan, SQLite index, download source provenance, format filters, search, incremental loading |
| Playback | FLAC / MP3 / M4A / WAV / OGG, Range audio server, play queue, locate current track, bounded recent history |
| Lyrics | local `.lrc` loading and scroll highlighting |
| Online | local `go-music-dl` proxy for search, download queue and task actions |
| Accounts | NetEase / QQ QR login, Soda client cookie import |
| Likes | sync configuration, status, failed-task cleanup |
| Extensions | install/enable/disable/remove, source auto-registration, extension source search, local download import, extension job scheduling, extension SDK |
| AI control | localhost HTTP API + MCP, configurable port with automatic fallback |
| Recording | system-audio recording, playback, delete, paginated list |
| Desktop | single-instance wake-up, Windows tray, frameless window, themes, UI scale |
| Themes | vinyl, paper, celadon, green, ocean, cherry, follow system |

### Download

Windows portable build:

```text
release/LSA-portable/LSA.exe
```

macOS uses an unsigned DMG/zip. On first launch, right-click → Open in Finder, or allow it in System Settings.

> The macOS build is unsigned and not notarized. It is not distributed through the App Store. Installation on real Mac hardware has not yet been smoke-tested.

### Development

Requires Node.js 22+.

```bash
npm ci
npm test   # core unit tests
npm start
```

Optional environment variables:

```text
LSA_MUSIC_DIR       music folders, separated by the platform path separator
LSA_DATA_DIR        local data directory
LSA_BACKEND_URL     go-music-dl URL, default http://127.0.0.1:18088
```

### Configuration

- `config/default.json`: public defaults, no personal paths;
- `config/local.example.json`: placeholder-only local example;
- `<data>/config.json`: per-machine music folders and backend URL;
- `<data>/admin-credentials.txt`: backend admin credentials, never committed.

### Build

Windows:

```bash
npm run package:win
```

macOS:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac
```

The macOS build uses the hardened-runtime entitlements in `build/entitlements.mac.plist`. Signing and notarization require your own Apple Developer credentials.

### Online backend

Search, QR login and downloads require a local `go-music-dl` service on `127.0.0.1:18088`. The app does not bundle it.

### External source extension

YouTube Music is available as an optional extension in `extension-sdk/examples/youtube-music`. It uses a local `yt-dlp` binary for search and resolution. Soda Music is available in `extension-sdk/examples/soda`, with auth, search, queueing and likes sync through the extension contract.

```text
<data>/tools/yt-dlp.exe      # Windows
<data>/tools/yt-dlp          # macOS / Linux
```

Install it from Settings → Extensions → Install from folder. The extension can be disabled or removed without affecting the core client.

### AI control

Enable AI control in Settings to start a localhost control server and generate MCP configuration. The default port is `18765`; it can be changed and automatically falls back when occupied. The token stays in the local data directory.

### Project layout

```text
src/main/index.js       main-process entry, window and IPC composition
src/main/services/      main-process domain services
src/preload/index.js    narrow contextBridge surface
ui/                     renderer assets
ai-control/             local AI-control protocol and MCP bridge
extension-sdk/          extension contract, docs and sample
scripts/                build, portable packaging, likes sync, launcher
config/                 public defaults and vendor audit pins
docs/                   architecture, workflow, ADRs and screenshots
```

More documents:

- [Architecture](docs/architecture.md)
- [Engineering workflow](docs/engineering-workflow.md)
- [Testing strategy](docs/testing.md)
- [Reference architectures](docs/reference-architectures.md)
- [Feature delivery checklist](docs/checklists/feature-delivery.md)
- [UI delivery gate](docs/checklists/ui-delivery.md)

### Release audit

Source, configuration, README and the launcher must pass `privacy-audit`. The official Electron runtime is handled through a SHA256-pinned vendor allowlist; it is not user data, and the audit must not be bypassed by damaging the binary.

### License

MIT







