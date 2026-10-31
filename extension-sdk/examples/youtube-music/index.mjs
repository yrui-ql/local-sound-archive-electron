import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const extensionDir = process.env.LSA_EXTENSION_DIR || process.cwd()
const dataDir = process.env.LSA_DATA_DIR || path.resolve(extensionDir, '..', '..')
const toolCandidates = [
  process.env.YTDLP_PATH,
  path.join(dataDir, 'tools', 'yt-dlp.exe'),
  path.join(dataDir, 'tools', 'yt-dlp'),
  'yt-dlp',
].filter(Boolean)
const tool = toolCandidates.find((candidate) => candidate === 'yt-dlp' || fs.existsSync(candidate))

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function run(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!tool) return reject(new Error('未找到 yt-dlp，请先安装到 data/tools/yt-dlp.exe'))
    const child = spawn(tool, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { }
      reject(new Error('yt-dlp 超时'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error((stderr || stdout || 'yt-dlp 退出码 ' + code).trim().slice(-400)))
    })
  })
}

function safeTitle(value) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
}

async function search(query, limit = 10) {
  const { stdout } = await run([
    'ytsearch' + Math.max(1, Math.min(20, Number(limit) || 10)) + ':' + query,
    '--flat-playlist', '--dump-single-json', '--no-warnings', '--skip-download',
    '--socket-timeout', '20',
  ], 45000)
  const parsed = JSON.parse(stdout || '{}')
  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  return entries.filter((entry) => entry.id).map((entry) => ({
    id: String(entry.id),
    title: entry.title || '未知歌曲',
    artist: entry.uploader || entry.channel || 'YouTube Music',
    album: '',
    duration: Number(entry.duration) || 0,
    cover: Array.isArray(entry.thumbnails) && entry.thumbnails.length ? entry.thumbnails[entry.thumbnails.length - 1].url : '',
    source: 'youtube-music',
  }))
}

async function resolve(song, outputDir) {
  if (!song || !song.id) throw new Error('缺少 YouTube 视频 id')
  await fs.promises.mkdir(outputDir, { recursive: true })
  const url = 'https://music.youtube.com/watch?v=' + encodeURIComponent(song.id)
  const template = path.join(outputDir, '%(title)s.%(ext)s')
  const { stdout } = await run([
    url,
    '--no-playlist', '--no-warnings', '--restrict-filenames',
    '--format', 'bestaudio[ext=m4a]/bestaudio',
    '--output', template,
    '--print', 'after_move:filepath',
  ], 14 * 60 * 1000)
  const file = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop()
  if (!file || !fs.existsSync(file)) throw new Error('yt-dlp 没有生成音频文件')
  return { file, title: safeTitle(song.title || song.name), artist: song.artist || '' }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  try {
    if (request.method === 'describe') {
      return send(request.id, { name: 'YouTube Music', version: '0.1.0', capabilities: ['search', 'resolve', 'health'] })
    }
    if (request.method === 'health') {
      if (!tool) return send(request.id, { ok: false, error: '未找到 yt-dlp' })
      const { stdout } = await run(['--version'], 15000)
      return send(request.id, { ok: true, version: stdout.trim() })
    }
    if (request.method === 'search') {
      return send(request.id, { songs: await search(String(request.params?.query || ''), request.params?.limit) })
    }
    if (request.method === 'resolve') {
      return send(request.id, await resolve(request.params?.song, request.params?.outputDir))
    }
    send(request.id, { ok: false, error: 'unknown method: ' + request.method })
  } catch (error) {
    send(request.id, { ok: false, error: error.message || String(error) })
  }
})
