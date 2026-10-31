const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')
const { LibraryStore } = require('./library')
const { ExtensionStore } = require('./extensions')
const { ExtensionHost } = require('./extension-host')
const { LikesStore } = require('./likes')

const isMac = process.platform === 'darwin'
app.setAppUserModelId('com.local-sound-archive.app')

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma'])
const APP_ROOT = path.join(__dirname, '..')
const RENDERER = path.join(APP_ROOT, 'ui')
const DATA_DIR = process.env.LSA_DATA_DIR
  ? path.resolve(process.env.LSA_DATA_DIR)
  : path.join(isMac ? app.getPath('userData') : APP_ROOT, 'data')
let musicDirs = []
let config = {}
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const BACKEND_URL = process.env.LSA_BACKEND_URL || 'http://127.0.0.1:18088'

let mainWindow = null
const STARTUP_LOG = path.join(APP_ROOT, 'data', 'startup.log')
function logStart(message) {
  try {
    fs.mkdirSync(path.dirname(STARTUP_LOG), { recursive: true })
    fs.appendFileSync(STARTUP_LOG, new Date().toISOString() + ' ' + message + '\n')
  } catch { }
}
let audioServer = null
let audioPort = 0
const audioToken = crypto.randomBytes(18).toString('hex')
const AI_CONFIG_PATH = path.join(DATA_DIR, 'ai-control.json')
const AI_DOCS_PATH = path.join(APP_ROOT, 'ai-control', 'AI_CONTROL.md')
const AI_MCP_PATH = path.join(APP_ROOT, 'ai-control', 'mcp-server.mjs')
let aiConfig = { enabled: false, port: 18765, token: crypto.randomBytes(18).toString('hex') }
let aiServer = null
let aiLastError = ''
let libraryStore = null
let extensionStore = null
let extensionHost = null
let likesStore = null

async function loadConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  if (!libraryStore) libraryStore = new LibraryStore(path.join(DATA_DIR, 'library.db'))
  if (!extensionStore) extensionStore = new ExtensionStore(path.join(DATA_DIR, 'extensions'), path.join(APP_ROOT, 'extension-sdk', 'sample-source'))
  if (!extensionHost) extensionHost = new ExtensionHost(extensionStore)
  if (!likesStore) likesStore = new LikesStore(DATA_DIR, BACKEND_URL)
  try {
    if (fs.existsSync(CONFIG_PATH)) config = JSON.parse((await fsp.readFile(CONFIG_PATH, 'utf8')).replace(/^\uFEFF/, ''))
  } catch { config = {} }
  const envDirs = process.env.LSA_MUSIC_DIR
    ? process.env.LSA_MUSIC_DIR.split(path.delimiter)
    : null
  const configured = Array.isArray(config.musicDirs) && config.musicDirs.length
    ? config.musicDirs
    : [app.getPath('music')]
  musicDirs = (envDirs || configured).map((p) => path.resolve(p)).filter(Boolean)
  if (!Array.isArray(config.musicDirs) || !config.musicDirs.length) {
    config.musicDirs = musicDirs
    await saveConfig()
  }
}

async function saveConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

function trackPathFromUrl(url) {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').pop()
    return Buffer.from(last, 'base64url').toString('utf8')
  } catch { return '' }
}

function mimeFor(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.mp3': return 'audio/mpeg'
    case '.m4a':
    case '.aac': return 'audio/mp4'
    case '.wav': return 'audio/wav'
    case '.ogg':
    case '.opus': return 'audio/ogg'
    case '.flac': return 'audio/flac'
    default: return 'application/octet-stream'
  }
}

function publicTrack(file, root) {
  const ext = path.extname(file).slice(1).toLowerCase()
  const id = Buffer.from(file, 'utf8').toString('base64url')
  return {
    id,
    path: file,
    url: `http://127.0.0.1:${audioPort}/audio/${audioToken}/${id}`,
    title: path.basename(file, path.extname(file)),
    artist: path.basename(path.dirname(file)),
    album: '',
    ext,
    format: ext.toUpperCase(),
    size: 0,
    duration: 0,
    mtime: 0,
    sourceRoot: root || '',
  }
}

async function collectAudioFiles(root, out, budget = 5000) {
  if (out.length >= budget) return
  let entries
  try { entries = await fsp.readdir(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= budget) break
    if (entry.name.startsWith('.')) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) await collectAudioFiles(full, out, budget)
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full)
  }
}

async function buildLibrary() {
  const files = []
  for (const root of musicDirs) await collectAudioFiles(root, files)
  const tracks = []
  const formats = {}
  let totalBytes = 0
  for (const file of files) {
    const track = publicTrack(file, musicDirs.find((root) => file.startsWith(root + path.sep)))
    try {
      const stat = await fsp.stat(file)
      track.size = stat.size
      track.mtime = stat.mtimeMs
    } catch { }
    formats[track.ext] = (formats[track.ext] || 0) + 1
    totalBytes += Number(track.size) || 0
    tracks.push(track)
  }
  if (libraryStore) libraryStore.replaceTracks(tracks)
  return { tracks, formats, totalBytes, libraryRoot: musicDirs[0] || '' }
}
function startAudioServer() {
  return new Promise((resolve, reject) => {
    audioServer = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1')
        const prefix = `/audio/${audioToken}/`
        if (!url.pathname.startsWith(prefix)) {
          res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
          return res.end('not found')
        }
        const token = url.pathname.slice(prefix.length)
        const file = Buffer.from(token, 'base64url').toString('utf8')
        const resolved = path.resolve(file)
        const allowed = musicDirs.some((root) => resolved === root || resolved.startsWith(root + path.sep))
        if (!allowed || !fs.existsSync(resolved)) {
          res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
          return res.end('not found')
        }
        const total = fs.statSync(resolved).size
        const range = req.headers.range
        const headers = {
          'Content-Type': mimeFor(resolved),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        }
        if (range) {
          const match = /bytes=(\d*)-(\d*)/.exec(range)
          const start = match && match[1] ? Number(match[1]) : 0
          const end = match && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
          if (start > end || start >= total) {
            res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` })
            return res.end()
          }
          headers['Content-Range'] = `bytes ${start}-${end}/${total}`
          headers['Content-Length'] = String(end - start + 1)
          res.writeHead(206, headers)
          return fs.createReadStream(resolved, { start, end }).pipe(res)
        }
        headers['Content-Length'] = String(total)
        res.writeHead(200, headers)
        fs.createReadStream(resolved).pipe(res)
      } catch (error) {
        try { res.writeHead(500, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }); res.end(String(error)) } catch { }
      }
    })
    audioServer.once('error', reject)
    audioServer.listen(0, '127.0.0.1', () => {
      audioPort = audioServer.address().port
      resolve(audioPort)
    })
  })
}

function htmlDecode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

async function backendJson(pathname, options) {
  const response = await fetch(BACKEND_URL + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  if (!response.ok) throw new Error(typeof data === 'string' ? data : (data?.error || `HTTP ${response.status}`))
  return data
}

async function checkBackend() {
  backendAvailable = await new Promise((resolve) => {
    const req = http.get(BACKEND_URL + '/', { timeout: 1800 }, (response) => {
      response.resume()
      resolve(response.statusCode < 500)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
  return backendAvailable
}

async function searchBackend(query) {
  if (!String(query || '').trim()) return { songs: [], count: 0 }
  const response = await fetch(`${BACKEND_URL}/music/search?q=${encodeURIComponent(query)}&type=song&page=1&page_size=30`)
  if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}`)
  const html = await response.text()
  const songs = []
  for (const match of html.matchAll(/<li class="song-card"([\s\S]*?)>/g)) {
    const attrs = {}
    for (const attr of match[1].matchAll(/data-([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[attr[1]] = htmlDecode(attr[2] ?? attr[3] ?? '')
    }
    if (!attrs.id) continue
    let extra = {}
    try { extra = JSON.parse(attrs.extra || '{}') } catch { extra = {} }
    songs.push({
      id: attrs.id,
      source: attrs.source || '',
      name: attrs.name || '未知',
      artist: attrs.artist || '未知',
      album: attrs.album || '',
      cover: attrs.cover || '',
      duration: Number(attrs.duration) || 0,
      extra,
    })
  }
  return { songs, count: songs.length }
}

async function getDownloads() {
  try {
    const [queue, records] = await Promise.all([
      backendJson('/music/api/downloads/queue?page=1&page_size=200'),
      backendJson('/music/api/downloads/records?page=1&page_size=100'),
    ])
    backendAvailable = true
    return { queue, records }
  } catch (error) {
    backendAvailable = false
    return { error: error.message }
  }
}

async function queueDownloads(songs) {
  if (!Array.isArray(songs) || !songs.length) return { ok: false, error: '没有选择歌曲' }
  const payload = {
    request_id: crypto.randomUUID(),
    songs: songs.map((song) => ({
      id: String(song.id || ''),
      source: String(song.source || ''),
      name: String(song.name || ''),
      artist: String(song.artist || ''),
      album: String(song.album || ''),
      cover: String(song.cover || ''),
      extra: typeof song.extra === 'string' ? song.extra : JSON.stringify(song.extra || {}),
      embed: false,
    })),
  }
  const response = await fetch(BACKEND_URL + '/music/api/downloads/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  if (!response.ok) return { ok: false, error: text }
  backendAvailable = true
  return { ok: true, queued: payload.songs.length }
}

async function downloadAction(args) {
  const action = String(args?.action || '')
  const id = Number(args?.id) || 0
  if (action === 'clear') {
    const response = await fetch(BACKEND_URL + '/music/api/downloads/queue', { method: 'DELETE' })
    return { ok: response.ok, status: response.status, body: await response.text() }
  }
  if (!['retry', 'cancel'].includes(action) || id <= 0) return { ok: false, error: '不支持的任务操作' }
  const response = await fetch(`${BACKEND_URL}/music/api/downloads/queue/${id}/${action}`, {
    method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' },
  })
  return { ok: response.ok, status: response.status, body: await response.text() }
}
async function loadAiConfig() {
  try {
    if (fs.existsSync(AI_CONFIG_PATH)) aiConfig = { ...aiConfig, ...JSON.parse((await fsp.readFile(AI_CONFIG_PATH, 'utf8')).replace(/^\uFEFF/, '')) }
  } catch { }
  if (!aiConfig.token) aiConfig.token = crypto.randomBytes(18).toString('hex')
  if (!aiConfig.port) aiConfig.port = 18765
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  await fsp.writeFile(AI_CONFIG_PATH, JSON.stringify(aiConfig, null, 2), 'utf8')
}

function aiStatus() {
  return {
    ok: true,
    enabled: !!aiConfig.enabled,
    running: !!(aiServer && aiServer.listening),
    port: aiConfig.port,
    endpoint: aiConfig.enabled ? `http://127.0.0.1:${aiConfig.port}/v1` : '',
    mcpServerPath: AI_MCP_PATH,
    configPath: AI_CONFIG_PATH,
    error: aiLastError,
  }
}

async function executeAiCommand(action, args = {}) {
  if (!mainWindow) throw new Error('window not ready')
  const code = `handleAiCommand(${JSON.stringify(action)}, ${JSON.stringify(args)})`
  return mainWindow.webContents.executeJavaScript(code, true)
}

function startAiServer() {
  if (aiServer) return aiStatus()
  return new Promise((resolve) => {
    aiLastError = ''
    const server = http.createServer(async (req, res) => {
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(data))
      }
      try {
        const token = req.headers['x-lsa-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
        if (token !== aiConfig.token) return send(401, { ok: false, error: 'unauthorized' })
        const url = new URL(req.url, `http://127.0.0.1:${aiConfig.port}`)
        if (url.pathname === '/v1/health') return send(200, { ok: true, service: 'lsa-ai-control', version: '1' })
        if (url.pathname === '/v1/status' && req.method === 'GET') return send(200, await executeAiCommand('status'))
        if (url.pathname === '/v1/library' && req.method === 'GET') {
          return send(200, await executeAiCommand('librarySearch', {
            query: url.searchParams.get('query') || '',
            limit: Number(url.searchParams.get('limit')) || 20,
          }))
        }
        if (url.pathname === '/v1/command' && req.method === 'POST') {
          let body = ''
          for await (const chunk of req) body += chunk
          const payload = JSON.parse(body || '{}')
          return send(200, await executeAiCommand(String(payload.action || ''), payload.args || {}))
        }
        return send(404, { ok: false, error: 'not found' })
      } catch (error) {
        send(500, { ok: false, error: error.message })
      }
    })
    server.once('error', (error) => {
      aiLastError = error.message
      try { server.close() } catch { }
      resolve(aiStatus())
    })
    server.listen(aiConfig.port, '127.0.0.1', () => {
      aiServer = server
      resolve(aiStatus())
    })
  })
}

function stopAiServer() {
  if (aiServer) {
    try { aiServer.close() } catch { }
    aiServer = null
  }
}

async function copyAiMcpConfig() {
  const cfg = {
    mcpServers: {
      lsa: {
        command: 'node',
        args: [AI_MCP_PATH, '--config', AI_CONFIG_PATH],
      },
    },
  }
  require('electron').clipboard.writeText(JSON.stringify(cfg, null, 2))
  return { ok: true }
}

async function syncLikesNow() {
  const script = path.join(APP_ROOT, 'scripts', 'likes-sync.mjs')
  if (!fs.existsSync(script)) return { ok: false, error: '喜欢同步脚本缺失' }
  return new Promise((resolve) => {
    const child = require('node:child_process').spawn(process.execPath, [script, '--apply'], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        LSA_DATA_DIR: DATA_DIR,
        LSA_BACKEND_URL: BACKEND_URL,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    const timer = setTimeout(() => { try { child.kill() } catch { } }, 10 * 60 * 1000)
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      let lastRun = null
      try { lastRun = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'likes', 'last-run.json'), 'utf8')) } catch { }
      resolve({
        ok: code === 0,
        queued: Number(lastRun?.queued) || 0,
        report: lastRun?.report || null,
        output: output.slice(-4000),
        error: code === 0 ? null : (output.trim().split('\n').slice(-1)[0] || '同步失败'),
      })
    })
  })
}

async function openSdkDoc(file) {
  const target = path.join(APP_ROOT, 'extension-sdk', file)
  if (!fs.existsSync(target)) return { ok: false, error: '文档不存在' }
  const error = await shell.openPath(target)
  return error ? { ok: false, error } : { ok: true }
}

function detectAgents() {
  const candidates = [
    { id: 'codex', name: 'Codex', command: 'codex' },
    { id: 'claude', name: 'Claude Code', command: 'claude' },
    { id: 'dsh', name: 'DSH', command: 'dsh' },
  ]
  return {
    agents: candidates.map((agent) => {
      const candidatesPath = []
      for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue
        candidatesPath.push(path.join(dir, process.platform === 'win32' ? agent.command + '.cmd' : agent.command))
        candidatesPath.push(path.join(dir, process.platform === 'win32' ? agent.command + '.exe' : agent.command))
      }
      const found = candidatesPath.find((candidate) => fs.existsSync(candidate)) || ''
      return { ...agent, found: !!found, path: found }
    }),
  }
}

async function openLikesReport() {
  const lastRun = await likesStore.readJson(likesStore.lastRunPath, null)
  const report = lastRun && lastRun.report
  if (!report || !fs.existsSync(report)) return { ok: false, error: '还没有同步报告' }
  const error = await shell.openPath(report)
  return error ? { ok: false, error } : { ok: true }
}

async function handleCommand(cmd, args) {
  switch (cmd) {
    case 'ready':
      await checkBackend()
      return { backend: backendAvailable, libraryRoot: musicDirs[0] || '', dataRoot: DATA_DIR }
    case 'getLibrary':
      return buildLibrary()
    case 'getAppInfo':
      return {
        libraryRoot: musicDirs[0] || '',
        dataRoot: DATA_DIR,
        sources: musicDirs,
        musicDir: musicDirs[0] || '',
        recordingDir: path.join(DATA_DIR, 'recordings'),
        reportDir: path.join(DATA_DIR, 'reports'),
        qqNote: 'Electron M1 shell',
      }
    case 'getDownloads':
      return getDownloads()
    case 'search': {
      let result = null
      try { result = await searchBackend(args?.query) } catch { }
      if (result && result.songs && result.songs.length) return result
      const fallback = await extensionHost.search(String(args?.query || ''))
      return { songs: fallback.songs, count: fallback.songs.length, errors: fallback.errors }
    }
    case 'download':
      return queueDownloads(args?.songs)
    case 'downloadAction':
      return downloadAction(args)
    case 'recordings':
      return { items: [] }
    case 'getLikes':
      return likesStore.status()
    case 'saveLikes':
      return { ok: true, config: await likesStore.saveConfig(args) }
    case 'syncLikes':
      return syncLikesNow()
    case 'getExtensions':
      return extensionStore.list()
    case 'installExtension':
      return extensionStore.install(String(args?.path || ''))
    case 'installSampleExtension':
      return extensionStore.installSample()
    case 'extensionAction':
      return extensionStore.action(String(args?.id || ''), String(args?.action || ''))
    case 'setExtensionSafeMode':
      return extensionStore.setSafeMode(!!args?.safeMode)
    case 'getAgents':
      return detectAgents()
    case 'launchAgent': {
      const id = String(args?.id || '')
      if (!id) return { ok: false, error: '缺少开发工具 id' }
      const workspace = path.join(DATA_DIR, 'agent-workspaces', id)
      await fsp.mkdir(workspace, { recursive: true })
      const error = await shell.openPath(workspace)
      return error ? { ok: false, error } : { ok: true, workspace }
    }
    case 'openExtensionDocs':
      return openSdkDoc('EXTENSIONS.md')
    case 'openExtensionCapabilities':
      return openSdkDoc('CAPABILITIES.md')
    case 'openLikesReport':
      return openLikesReport()
    case 'maintain': {
      const result = await buildLibrary()
      return { ok: true, summary: { tracks: result.tracks.length, formats: result.formats, totalBytes: result.totalBytes } }
    }
    case 'clearFailed':
      return { ok: false, error: 'Electron 端暂未接入失败任务清理' }
    case 'getAiControlStatus':
      return aiStatus()
    case 'setAiControlEnabled': {
      aiConfig.enabled = !!args?.enabled
      await fsp.writeFile(AI_CONFIG_PATH, JSON.stringify(aiConfig, null, 2), 'utf8')
      if (aiConfig.enabled) await startAiServer()
      else stopAiServer()
      return aiStatus()
    }
    case 'copyAiMcpConfig':
      return copyAiMcpConfig()
    case 'openAiControlDocs':
      await shell.openPath(AI_DOCS_PATH)
      return { ok: true }
    case 'chooseFolder': {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: musicDirs[0] || app.getPath('music'),
      })
      return { ok: !result.canceled, path: result.filePaths?.[0] || '' }
    }
    case 'setLibraryRoot': {
      const next = String(args?.path || '').trim()
      if (!next) return { ok: false, error: 'empty path' }
      musicDirs = [path.resolve(next)]
      config.musicDirs = musicDirs
      await saveConfig()
      return { ok: true, libraryRoot: musicDirs[0] }
    }
    case 'addSourceDir': {
      const next = String(args?.path || '').trim()
      if (!next) return { ok: false, error: 'empty path' }
      const resolved = path.resolve(next)
      if (!musicDirs.includes(resolved)) musicDirs.push(resolved)
      config.musicDirs = musicDirs
      await saveConfig()
      return { ok: true, sources: musicDirs }
    }
    case 'removeSourceDir': {
      const next = path.resolve(String(args?.path || ''))
      musicDirs = musicDirs.filter((item) => item !== next)
      if (!musicDirs.length) musicDirs = [app.getPath('music')]
      config.musicDirs = musicDirs
      await saveConfig()
      return { ok: true, sources: musicDirs }
    }
    case 'openFolder': {
      const kind = String(args?.kind || '')
      const target = kind === 'data' ? DATA_DIR : (musicDirs[0] || app.getPath('music'))
      const error = await shell.openPath(target)
      return error ? { ok: false, error } : { ok: true, path: target }
    }
    case 'getLyrics': {
      const trackFile = trackPathFromUrl(String(args?.url || ''))
      if (!trackFile) return { ok: false, error: '无法识别歌曲路径' }
      const resolvedTrack = path.resolve(trackFile)
      if (!musicDirs.some((root) => resolvedTrack.startsWith(root + path.sep))) return { ok: false, error: '不在音乐库目录内' }
      const ext = path.extname(trackFile)
      const candidates = [
        trackFile.slice(0, -ext.length) + '.lrc',
        trackFile.slice(0, -ext.length) + '.LRC',
        path.join(path.dirname(trackFile), 'lyrics', path.basename(trackFile, ext) + '.lrc'),
      ]
      for (const candidate of candidates) {
        try {
          if (!fs.existsSync(candidate)) continue
          const lrc = await fsp.readFile(candidate, 'utf8')
          return { ok: true, lrc, source: 'local', local: true }
        } catch { }
      }
      return { ok: false, error: '没有找到本地歌词' }
    }
    case 'setTheme':
    case 'setUiScale':
      return { ok: true }
    case 'copyText':
      require('electron').clipboard.writeText(String(args?.text || ''))
      return { ok: true }
    default:
      throw new Error(`Not implemented in Electron M1: ${cmd}`)
  }
}

async function createWindow() {
  logStart('createWindow:start')
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0b0d10',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    show: false,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => { logStart('ready-to-show'); mainWindow.show() })
  try { await mainWindow.loadFile(path.join(RENDERER, 'index.html')); logStart('loadFile:ok') } catch (error) { logStart('loadFile:error ' + error.stack) ; throw error }
  if (process.env.LSA_SMOKE) {
    setTimeout(async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return {
            library: document.querySelectorAll('#libList .row').length,
            audio: !!document.querySelector('#audio'),
            aiBridge: typeof window.handleAiCommand === 'function',
            windowControls: !!document.querySelector('#windowControls'),
          };
        })()`, true);
        const report = { ok: result.library >= 0 && result.audio && result.aiBridge, ...result, dataDir: DATA_DIR, musicDirs };
        fs.writeFileSync(path.join(DATA_DIR, 'smoke.json'), JSON.stringify(report, null, 2));
        console.log('LSA_SMOKE ' + JSON.stringify(report));
      } catch (error) {
        console.error('LSA_SMOKE_FAILED ' + error.stack);
      } finally {
        setTimeout(() => app.quit(), 400);
      }
    }, 1800);
  }
  mainWindow.webContents.on('did-fail-load', (_, code, description) => {
    console.error('renderer failed to load:', code, description)
  })
}

ipcMain.on('host-call', async (event, msg) => {
  const id = msg?.id
  try {
    const data = await handleCommand(msg?.cmd, msg?.args || {})
    event.sender.send('host-event', { id, ok: true, data })
  } catch (error) {
    event.sender.send('host-event', { id, ok: false, error: error.message })
  }
})

ipcMain.handle('window-action', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return false
  if (action === 'minimize') win.minimize()
  if (action === 'toggle-maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
  if (action === 'maximize') win.maximize()
  if (action === 'unmaximize') win.unmaximize()
  if (action === 'close') win.close()
  if (action === 'state') return { maximized: win.isMaximized() }
  return true
})

app.whenReady().then(async () => {
  await loadConfig()
  await loadAiConfig()
  await startAudioServer()
  await createWindow()
  if (aiConfig.enabled) await startAiServer()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('before-quit', () => {
  stopAiServer()
  if (audioServer) {
    try { audioServer.close() } catch { }
  }
})


























