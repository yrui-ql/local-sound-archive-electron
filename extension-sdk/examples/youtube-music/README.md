# YouTube Music source extension

A source extension for LSA. It uses a local `yt-dlp` binary for search and audio
resolution. It does not bundle `yt-dlp` in the repository.

## Requirements

- Node.js runtime provided by LSA;
- `yt-dlp` available at one of:
  - `<LSA data>/tools/yt-dlp.exe` (Windows);
  - `<LSA data>/tools/yt-dlp` (macOS/Linux);
  - `YTDLP_PATH` environment variable;
  - `yt-dlp` in `PATH`.

Windows install:

```powershell
$data = "<LSA data directory>"
New-Item -ItemType Directory -Force "$data\tools" | Out-Null
Invoke-WebRequest "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile "$data\tools\yt-dlp.exe"
```

macOS/Linux install:

```bash
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "<data>/tools/yt-dlp"
chmod +x "<data>/tools/yt-dlp"
```

## Install

1. LSA → 设置 → 扩展 → 从文件夹安装；
2. Select this directory;
3. Enable `YouTube Music`;
4. Search in 搜索下载；results from YouTube Music are marked with that source;
5. Download to the configured music library under `LSA Downloads`.

## Contract

`search` returns songs with `id`, `title`, `artist`, `duration`, `cover`.
`resolve` receives `{ song, outputDir }` and must write the audio file inside
`outputDir`, returning `{ file, title, artist }`.

## Notice

Use this only with content you are allowed to download. YouTube's terms of
service and local copyright rules still apply. This extension is optional and
can be disabled without affecting the core client.
