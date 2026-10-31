const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, session, Tray, Menu, nativeImage } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { LibraryStore } = require('./services/library')
const { ExtensionStore } = require('./services/extensions')
const { ExtensionHost } = require('./services/extension-host')
const { ExtensionScheduler } = require('./services/extension-scheduler')
const { cleanTitleText, cleanDisplayTitle, safeFileName, isPathInside } = require('./services/files')
const { buildSourceRegistry } = require('./services/sources')
const { candidatePaths, parseDisplayIcon } = require('./services/agents')
const { ProvenanceStore } = require('./services/provenance')
const QRCode = require('qrcode')
const { LikesStore } = require('./services/likes')
const { AccountService } = require('./services/account')

const isMac = process.platform === 'darwin'
app.setAppUserModelId('com.local-sound-archive.app')

// One process per user session. A second launch should wake the existing window.
const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.exit(0)

let tray = null
let forceQuit = false

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma'])
const APP_ROOT = path.join(__dirname, '..', '..')
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
let aiStarting = false
let aiServer = null
let aiLastError = ''
let libraryStore = null
let extensionStore = null
let extensionHost = null
let extensionScheduler = null
let provenanceStore = null
let likesStore = null
let accountService = null

async function loadConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  if (!libraryStore) libraryStore = new LibraryStore(path.join(DATA_DIR, 'library.db'))
  if (!extensionStore) extensionStore = new ExtensionStore(path.join(DATA_DIR, 'extensions'), path.join(APP_ROOT, 'extension-sdk', 'sample-source'))
  if (!extensionHost) extensionHost = new ExtensionHost(extensionStore)
  if (!extensionScheduler) extensionScheduler = new ExtensionScheduler({ host: extensionHost, store: extensionStore, dataDir: DATA_DIR })
  if (!provenanceStore) provenanceStore = new ProvenanceStore(path.join(DATA_DIR, 'provenance.json'))
  if (!likesStore) likesStore = new LikesStore(DATA_DIR, BACKEND_URL)
  if (!accountService) accountService = new AccountService(DATA_DIR, BACKEND_URL)
  let defaults = {}
  try {
    const defaultPath = path.join(APP_ROOT, 'config', 'default.json')
    if (fs.existsSync(defaultPath)) defaults = JSON.parse((await fsp.readFile(defaultPath, 'utf8')).replace(/^\uFEFF/, ''))
  } catch { }
  try {
    if (fs.existsSync(CONFIG_PATH)) config = JSON.parse((await fsp.readFile(CONFIG_PATH, 'utf8')).replace(/^\uFEFF/, ''))
  } catch { config = {} }
  config = { ...defaults, ...config }
  const configuredUiScale = Number(config.uiScale)
  config.uiScale = Number.isFinite(configuredUiScale) && configuredUiScale >= 0.85 && configuredUiScale <= 1.5
    ? Math.round(configuredUiScale * 100) / 100
    : 1
  const legacyConfigPath = path.join(DATA_DIR, 'client-config.json')
  if ((!Array.isArray(config.musicDirs) || !config.musicDirs.length) && fs.existsSync(legacyConfigPath)) {
    try {
      const legacy = JSON.parse((await fsp.readFile(legacyConfigPath, 'utf8')).replace(/^\uFEFF/, ''))
      const dirs = Array.isArray(legacy.sourceDirs) ? legacy.sourceDirs.slice() : []
      if (legacy.libraryRoot) dirs.unshift(path.join(legacy.libraryRoot, legacy.musicSubdir || '音乐'))
      if (dirs.length) config.musicDirs = dirs
    } catch { }
  }
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
    case '.webm': return 'audio/webm'
    default: return 'application/octet-stream'
  }
}

function audioUrlFor(file) {
  const id = Buffer.from(file, 'utf8').toString('base64url')
  return `http://127.0.0.1:${audioPort}/audio/${audioToken}/${id}`
}

function publicTrack(file, root) {
  const ext = path.extname(file).slice(1).toLowerCase()
  const id = Buffer.from(file, 'utf8').toString('base64url')
  return {
    id,
    path: file,
    url: audioUrlFor(file),
    title: cleanDisplayTitle(file),
    artist: path.basename(path.dirname(file)),
    album: '',
    source: '',
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
  await provenanceStore.load()
  const files = []
  for (const root of musicDirs) await collectAudioFiles(root, files)
  const tracks = []
  const formats = {}
  let totalBytes = 0
  for (const file of files) {
    const track = publicTrack(file, musicDirs.find((root) => file.startsWith(root + path.sep)))
    track.source = provenanceStore.lookup(file)
    try {
      const stat = await fsp.stat(file)
      track.size = stat.size
      track.mtime = stat.mtimeMs
    } catch { }
    formats[track.ext] = (formats[track.ext] || 0) + 1
    totalBytes += Number(track.size) || 0
    tracks.push(track)
  }
  for (const track of tracks) track.title = cleanTitleText(track.title)
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
        const recordingRoot = path.join(DATA_DIR, 'recordings')
        const allowed = musicDirs.some((root) => resolved === root || resolved.startsWith(root + path.sep)) ||
          resolved === recordingRoot || resolved.startsWith(recordingRoot + path.sep)
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

const FINISHED_QUEUE_STATUSES = new Set(['success', 'completed', 'done', 'finished'])

function queueTaskStatus(task) {
  return String(task?.Status || task?.status || '').toLowerCase()
}

function queueTaskId(task) {
  return Number(task?.ID || task?.id || 0)
}

function visibleQueueTasks(tasks) {
  return tasks.filter((task) => !FINISHED_QUEUE_STATUSES.has(queueTaskStatus(task)))
}

function recalculateQueue(queue, tasks) {
  const counts = { waiting: 0, downloading: 0, success: 0, failed: 0, skipped: 0, canceled: 0 }
  for (const task of tasks) {
    const status = queueTaskStatus(task)
    if (counts[status] !== undefined) counts[status]++
  }
  return { ...queue, tasks, total: tasks.length, counts }
}

async function fetchQueueWithAuth() {
  const admin = await accountService.ensureAdmin()
  const headers = admin ? { Cookie: accountService.cookie, 'X-Requested-With': 'XMLHttpRequest' } : { 'X-Requested-With': 'XMLHttpRequest' }
  const response = await fetch(BACKEND_URL + '/music/api/downloads/queue?page=1&page_size=200', { headers })
  const text = await response.text()
  if (!response.ok) throw new Error(text || `HTTP ${response.status}`)
  return { queue: JSON.parse(text), headers }
}

function extensionDownloadJobs() {
  return Array.from(localDownloads.values()).slice(-100).reverse()
}

async function getDownloads() {
  try {
    let { queue, headers } = await fetchQueueWithAuth()
    const tasks = Array.isArray(queue.tasks) ? queue.tasks : []
    const finished = tasks.filter((task) => FINISHED_QUEUE_STATUSES.has(queueTaskStatus(task)) && queueTaskId(task) > 0)
    for (const task of finished) {
      await fetch(`${BACKEND_URL}/music/api/downloads/queue/${queueTaskId(task)}`, { method: 'DELETE', headers }).catch(() => {})
    }
    if (finished.length) {
      const refreshed = await fetchQueueWithAuth()
      queue = refreshed.queue
    }
    const records = await backendJson('/music/api/downloads/records?page=1&page_size=100')
    if (provenanceStore && records && Array.isArray(records.records)) await provenanceStore.ingestRecords(records.records)
    backendAvailable = true
    return { queue: recalculateQueue(queue, visibleQueueTasks(Array.isArray(queue.tasks) ? queue.tasks : [])), records, extensionJobs: extensionDownloadJobs() }
  } catch (error) {
    backendAvailable = false
    return { error: error.message, extensionJobs: extensionDownloadJobs() }
  }
}

async function queueBackendDownloads(songs) {
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

async function queueDownloads(songs) {
  if (!Array.isArray(songs) || !songs.length) return { ok: false, error: '没有选择歌曲' }
  const extensionSongs = songs.filter((song) => song.extensionId)
  const backendSongs = songs.filter((song) => !song.extensionId)
  let backendResult = { ok: true, queued: 0 }
  if (backendSongs.length) backendResult = await queueBackendDownloads(backendSongs)
  if (extensionSongs.length) startExtensionDownloads(extensionSongs)
  if (!backendResult.ok && !extensionSongs.length) return backendResult
  return {
    ok: true,
    queued: (backendResult.queued || 0) + extensionSongs.length,
    extensionQueued: extensionSongs.length,
    backendQueued: backendResult.queued || 0,
  }
}

async function downloadAction(args) {
  const action = String(args?.action || '')
  const id = Number(args?.id) || 0
  const admin = await accountService.ensureAdmin()
  const headers = { 'X-Requested-With': 'XMLHttpRequest' }
  if (admin) headers.Cookie = accountService.cookie
  if (action === 'clear') {
    if (!admin) return { ok: false, error: '本机下载服务未登录，无法清空队列' }
    const response = await fetch(BACKEND_URL + '/music/api/downloads/queue', { method: 'DELETE', headers })
    const text = await response.text()
    if (!response.ok) return { ok: false, status: response.status, error: text || `清空失败（HTTP ${response.status}）` }
    return { ok: true, status: response.status, body: text }
  }
  if (action === 'clearRecords') {
    if (!admin) return { ok: false, error: '本机下载服务未登录，无法清空下载记录' }
    const response = await fetch(BACKEND_URL + '/music/api/downloads/records', { method: 'DELETE', headers })
    const text = await response.text()
    if (!response.ok) return { ok: false, status: response.status, error: text || `清空记录失败（HTTP ${response.status}）` }
    return { ok: true, status: response.status, body: text }
  }
  if (!['retry', 'cancel'].includes(action) || id <= 0) return { ok: false, error: '不支持的任务操作' }
  if (!admin) return { ok: false, error: '本机下载服务未登录' }
  const response = await fetch(`${BACKEND_URL}/music/api/downloads/queue/${id}/${action}`, {
    method: 'POST', headers,
  })
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text, error: response.ok ? undefined : text }
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
  if (aiStarting) return aiStatus()
  const preferred = Math.max(1, Number(aiConfig.port) || 18765)
  aiLastError = ''
  aiStarting = true
  return new Promise((resolve) => {
    const tryPort = (port, remaining) => {
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
        try { server.close() } catch { }
        if (error.code === 'EADDRINUSE' && remaining > 0) {
          tryPort(port + 1, remaining - 1)
          return
        }
        aiLastError = error.message
        aiStarting = false
        resolve(aiStatus())
      })
      server.listen(port, '127.0.0.1', () => {
        aiServer = server
        aiConfig.port = port
        aiStarting = false
        fsp.writeFile(AI_CONFIG_PATH, JSON.stringify(aiConfig, null, 2), 'utf8').catch(() => {})
        resolve(aiStatus())
      })
    }
    tryPort(preferred, 24)
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

function findWindowsInstalledApp(displayName, exeName) {
  if (process.platform !== 'win32') return ''
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const key of keys) {
    try {
      const output = spawnSync('reg.exe', ['query', key, '/s', '/f', displayName], {
        encoding: 'utf8', windowsHide: true, timeout: 2500,
      }).stdout || ''
      const candidate = parseDisplayIcon(output, exeName)
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch { }
  }
  return ''
}

function detectAgents() {
  const candidates = [
    { id: 'codex', name: 'Codex', command: 'codex', kind: 'cli' },
    { id: 'claude', name: 'Claude Code', command: 'claude', kind: 'cli' },
    { id: 'dsh', name: 'DSH', command: 'dsh', kind: 'gui', env: 'DSH_CLI' },
    { id: 'cursor', name: 'Cursor', command: 'cursor', kind: 'gui' },
  ]
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  return {
    agents: candidates.map((agent) => {
      const candidatesPath = candidatePaths(agent, { pathDirs, appRoot: APP_ROOT, env: process.env })
      if (agent.id === 'dsh' && process.platform === 'win32') {
        const registryPath = findWindowsInstalledApp('DeepSeek Harness', 'DeepSeek Harness.exe')
        if (registryPath) candidatesPath.push(registryPath)
      }
      const found = candidatesPath.find((candidate) => candidate && fs.existsSync(candidate)) || ''
      return { ...agent, found: !!found, path: found }
    }),
  }
}

function startAgentConversation(agent, workspace) {
  const quote = (value) => String(value).replace(/'/g, "''")
  if (agent.kind === 'gui') {
    const child = spawn(agent.path, [workspace], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return
  }
  if (process.platform === 'win32') {
    const script = `$Host.UI.RawUI.WindowTitle = 'LSA · ${quote(agent.name)}'; Set-Location -LiteralPath '${quote(workspace)}'; & '${quote(agent.path)}'`
    const child = spawn('powershell.exe', ['-NoExit', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return
  }
  if (process.platform === 'darwin') {
    const script = `cd '${quote(workspace)}' && '${quote(agent.path)}'`
    const child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${script.replace(/"/g, '\\"')}"`], { detached: true, stdio: 'ignore' })
    child.unref()
    return
  }
  const child = spawn('x-terminal-emulator', ['-e', agent.path], { cwd: workspace, detached: true, stdio: 'ignore' })
  child.unref()
}

async function openLikesReport() {
  const lastRun = await likesStore.readJson(likesStore.lastRunPath, null)
  const report = lastRun && lastRun.report
  if (!report || !fs.existsSync(report)) return { ok: false, error: '还没有同步报告' }
  const error = await shell.openPath(report)
  return error ? { ok: false, error } : { ok: true }
}

let recordingState = { active: false, startedAt: 0, stoppedAt: 0 }

function recordingsDir() {
  return path.join(DATA_DIR, 'recordings')
}

function postHostEvent(type, data = {}) {
  if (!mainWindow || !mainWindow.webContents) return
  mainWindow.webContents.send('host-event', { type, ...data })
}

async function listRecordings(args = {}) {
  await fsp.mkdir(recordingsDir(), { recursive: true }).catch(() => {})
  const page = Math.max(1, Number(args?.page) || 1)
  const pageSize = Math.min(100, Math.max(10, Number(args?.pageSize) || 40))
  const files = []
  try {
    for (const entry of await fsp.readdir(recordingsDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(webm|wav|mp3|m4a)$/i.test(entry.name)) continue
      const file = path.join(recordingsDir(), entry.name)
      const stat = await fsp.stat(file)
      files.push({ name: entry.name, path: file, url: audioUrlFor(file), size: stat.size, mtime: stat.mtimeMs })
    }
  } catch { }
  files.sort((a, b) => b.mtime - a.mtime)
  const start = (page - 1) * pageSize
  return { files: files.slice(start, start + pageSize), total: files.length, page, pageSize, hasMore: start + pageSize < files.length, dir: recordingsDir() }
}

async function deleteRecording(args) {
  const target = path.resolve(String(args?.path || ''))
  const root = path.resolve(recordingsDir())
  if (!target.startsWith(root + path.sep) || !/\.(webm|wav|mp3|m4a)$/i.test(target)) return { ok: false, error: '无效的录音文件' }
  try {
    await fsp.unlink(target)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

async function deleteTrack(args) {
  const target = path.resolve(String(args?.path || ''))
  if (!isPathInside(target, musicDirs)) return { ok: false, error: '只能删除音乐库目录内的文件' }
  if (!AUDIO_EXTENSIONS.has(path.extname(target).toLowerCase())) return { ok: false, error: '不是支持的音频文件' }
  if (!fs.existsSync(target)) return { ok: false, error: '文件不存在或已经移动' }
  try {
    await shell.trashItem(target)
    let ignored = false
    try {
      if (likesStore) {
        await likesStore.ignoreTrack({ path: target, title: String(args?.title || ''), artist: String(args?.artist || '') })
        ignored = true
      }
    } catch { }
    return { ok: true, path: target, ignored }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

async function saveRecording(args) {
  try {
    const ext = String(args?.ext || 'webm').replace(/[^a-z0-9]/gi, '') || 'webm'
    const name = String(args?.name || '').replace(/[\\/:*?"<>|]/g, '_') || ('录音-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext)
    await fsp.mkdir(recordingsDir(), { recursive: true })
    const target = path.join(recordingsDir(), name.endsWith('.' + ext) ? name : name + '.' + ext)
    await fsp.writeFile(target, Buffer.from(String(args?.data || ''), 'base64'))
    recordingState = { active: false, startedAt: 0, stoppedAt: Date.now() }
    return { ok: true, path: target }
  } catch (error) {
    recordingState = { active: false, startedAt: 0, stoppedAt: Date.now() }
    return { ok: false, error: error.message }
  }
}

async function clearFailedTasks() {
  if (!(await accountService.ensureAdmin())) return { ok: false, error: '本机下载服务未登录，无法清理失败任务' }
  const headers = { Cookie: accountService.cookie, 'X-Requested-With': 'XMLHttpRequest' }
  try {
    const ids = []
    for (let page = 1; page <= 20; page++) {
      const response = await fetch(`${BACKEND_URL}/music/api/downloads/queue?page=${page}&page_size=200`, { headers })
      if (!response.ok) return { ok: false, error: `读取队列失败（HTTP ${response.status}）` }
      const data = await response.json()
      const tasks = Array.isArray(data.tasks) ? data.tasks : []
      for (const task of tasks) {
        const status = String(task.Status || task.status || '').toLowerCase()
        const id = Number(task.ID || task.id || 0)
        if (status === 'failed' && id > 0) ids.push(id)
      }
      if (tasks.length < 200) break
    }
    let removed = 0
    for (const id of [...new Set(ids)]) {
      const response = await fetch(`${BACKEND_URL}/music/api/downloads/queue/${id}`, { method: 'DELETE', headers })
      if (response.ok) removed++
    }
    return { ok: true, removed }
  } catch (error) {
    return { ok: false, error: error.message }
  }
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
      const query = String(args?.query || '')
      let result = { songs: [], count: 0, errors: [] }
      try {
        const backend = await searchBackend(query)
        const registered = buildSourceRegistry((await extensionStore.list()).extensions)
        const overridden = new Set(registered.filter((source) => source.kind === 'extension').map((source) => source.id))
        result.songs.push(...(backend.songs || []).filter((song) => !overridden.has(song.source)))
      } catch (error) {
        result.errors.push('内置音源：' + error.message)
      }
      try {
        const extensions = await extensionHost.search(query)
        result.songs.push(...(extensions.songs || []))
        result.errors.push(...(extensions.errors || []))
      } catch (error) {
        result.errors.push('扩展音源：' + error.message)
      }
      result.count = result.songs.length
      return result
    }
    case 'extensionDownloads':
      return getExtensionDownloads()
    case 'getSources':
      return getSources()
    case 'extensionInvoke':
      return extensionHost.invoke(String(args?.id || ''), String(args?.method || ''), args?.params || {}, Number(args?.timeoutMs) || 30000)
    case 'getExtensionJobs':
      return { jobs: extensionScheduler ? extensionScheduler.jobs() : [] }
    case 'runExtensionJob': {
      const key = String(args?.key || '')
      if (!extensionScheduler || !extensionScheduler.state.jobs[key]) return { ok: false, error: '任务不存在' }
      return extensionScheduler.run(key)
    }
    case 'download':
      return queueDownloads(args?.songs)
    case 'downloadAction':
      return downloadAction(args)
    case 'recordings':
      return listRecordings(args)
    case 'recordDelete':
      return deleteRecording(args)
    case 'deleteTrack':
      return deleteTrack(args)
    case 'recordStart':
      if (recordingState.active) return { ok: false, error: '正在录音' }
      await fsp.mkdir(recordingsDir(), { recursive: true }).catch(() => {})
      recordingState = { active: true, startedAt: Date.now(), stoppedAt: 0 }
      postHostEvent('record-start')
      return { ok: true }
    case 'recordStop':
      postHostEvent('record-stop')
      recordingState = { ...recordingState, active: false, stoppedAt: Date.now() }
      return { ok: true }
    case 'recordStatus':
      return {
        recording: recordingState.active,
        seconds: recordingState.active ? Math.max(0, Math.floor((Date.now() - recordingState.startedAt) / 1000)) : 0,
      }
    case 'recordData':
      return saveRecording(args)
    case 'recordFail':
      recordingState = { active: false, startedAt: 0, stoppedAt: Date.now() }
      return { ok: false, error: String(args?.error || '录音失败') }
    case 'getLikes': {
      await accountService.refreshSoda()
      const status = await likesStore.status()
      const cookies = await accountService.cookieStatus()
      for (const source of status.sources) source.connected = !!cookies[source.id]
      return { ...status, cookies }
    }
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
      const agent = detectAgents().agents.find((item) => item.id === id)
      if (!agent || !agent.found) return { ok: false, error: '没有检测到 ' + id }
      startAgentConversation(agent, workspace)
      return { ok: true, workspace, launched: agent.kind === 'gui' ? 'app' : 'terminal', agent: agent.name }
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
    case 'qrStart':
      return accountService.qrStart(String(args?.source || ''))
    case 'qrPoll':
      return accountService.qrPoll(String(args?.source || ''), String(args?.key || ''))
    case 'clearFailed':
      return clearFailedTasks()
    case 'getAiControlStatus':
      return aiStatus()
    case 'setAiControlEnabled': {
      const requestedPort = Number(args?.port)
      if (Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535 && requestedPort !== aiConfig.port) {
        stopAiServer()
        aiConfig.port = requestedPort
      }
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
      const target = kind === 'recordings' ? recordingsDir() : (kind === 'data' ? DATA_DIR : (musicDirs[0] || app.getPath('music')))
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
      return { ok: true }
    case 'setUiScale': {
      const requested = Number(args?.scale)
      if (!Number.isFinite(requested)) return { ok: false, error: '无效的界面比例' }
      const scale = Math.round(Math.max(0.85, Math.min(1.5, requested)) * 100) / 100
      config.uiScale = scale
      await saveConfig()
      return { ok: true, scale }
    }
    case 'copyText':
      require('electron').clipboard.writeText(String(args?.text || ''))
      return { ok: true }
    case 'qrImage':
      return QRCode.toDataURL(String(args?.text || ''), { margin: 1, width: 360, errorCorrectionLevel: 'M' })
        .then((image) => ({ ok: true, image }))
        .catch((error) => ({ ok: false, error: error.message }))
    default:
      throw new Error(`Not implemented in Electron M1: ${cmd}`)
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow().catch((error) => logStart('recreate-window:error ' + error.stack))
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  if (tray) return
  const icon = nativeImage.createFromPath(path.join(APP_ROOT, 'build', 'icon.png'))
  tray = new Tray(icon)
  tray.setToolTip('留声 · LSA')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示留声', click: showMainWindow },
    { label: '隐藏到托盘', click: () => { if (mainWindow) mainWindow.hide() } },
    { type: 'separator' },
    { label: '退出留声', click: () => { forceQuit = true; app.quit() } },
  ]))
  tray.on('double-click', showMainWindow)
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
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.on('close', (event) => {
    if (!isMac && !forceQuit) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.once('ready-to-show', () => { logStart('ready-to-show'); mainWindow.show() })
  try { await mainWindow.loadFile(path.join(RENDERER, 'index.html'), { query: { uiScale: String(config.uiScale || 1) } }); logStart('loadFile:ok') } catch (error) { logStart('loadFile:error ' + error.stack) ; throw error }
  if (process.env.LSA_SMOKE) {
    setTimeout(async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const call = window.call;
          const safe = async (cmd, args = {}) => {
            try { return await call(cmd, args); } catch (error) { return { ok: false, error: error.message }; }
          };
          const agents = await safe('getAgents');
          const likes = await safe('getLikes');
          const extensions = await safe('getExtensions');
          const maintain = await safe('maintain');
          const theme = await safe('setTheme', { dark: true });
          const qr = await safe('qrStart', { source: 'netease' });
          if (typeof window.showPage === 'function') window.showPage('settings');
          await new Promise((resolve) => setTimeout(resolve, 350));
          return {
            library: document.querySelectorAll('#libList .row').length,
            audio: !!document.querySelector('#audio'),
            aiBridge: typeof window.handleAiCommand === 'function',
            windowControls: !!document.querySelector('#windowControls'),
            agents: Array.isArray(agents.agents) ? agents.agents.length : -1,
            likesConfig: !!(likes && likes.config),
            likesSources: likes && likes.cookies ? likes.cookies : {},
            qrOk: !!(qr && qr.ok),
            qrError: qr && qr.error ? qr.error : '',
            extensions: Array.isArray(extensions.extensions) ? extensions.extensions.length : -1,
            maintainOk: !!(maintain && maintain.ok),
            themeOk: !!(theme && theme.ok),
            settingsPage: !!document.querySelector('#page-settings.active'),
          };
        })()`, true);
        const report = {
          ok: result.library >= 0 && result.audio && result.aiBridge && result.agents >= 0 &&
              result.likesConfig && result.qrOk && result.extensions >= 0 && result.maintainOk && result.themeOk && result.settingsPage,
          ...result, dataDir: DATA_DIR, musicDirs,
        };
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
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] })
      if (!sources.length) return callback({})
      callback({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : true })
    } catch {
      callback({})
    }
  })
  await loadConfig()
  await loadAiConfig()
  await startAudioServer()
  await createWindow()
  await extensionScheduler.start()
  createTray()
  if (aiConfig.enabled) await startAiServer()
  app.on('activate', showMainWindow)
})

app.on('second-instance', showMainWindow)

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('before-quit', () => {
  forceQuit = true
  extensionScheduler?.stop()
  stopAiServer()
  if (audioServer) {
    try { audioServer.close() } catch { }
  }
})






































let libraryRefreshPromise = null;
const localDownloads = new Map();
function extensionDownloadDir() {
  if (!musicDirs.length) return null;
  return path.join(musicDirs[0], 'LSA Downloads');
}
async function refreshLibrarySoon() {
  if (libraryRefreshPromise) return libraryRefreshPromise;
  libraryRefreshPromise = buildLibrary().finally(() => { libraryRefreshPromise = null; });
  return libraryRefreshPromise;
}
async function downloadExtensionSong(song) {
  const job = {
    id: crypto.randomUUID(),
    name: song.name || '未知歌曲',
    artist: song.artist || '',
    source: song.extensionId || song.source || 'extension',
    status: 'downloading',
    error: '',
    at: new Date().toISOString(),
  };
  localDownloads.set(job.id, job);
  postHostEvent('extension-download', { id: job.id, status: 'downloading', name: job.name });
  const staging = path.join(DATA_DIR, 'downloads', 'staging', job.id);
  try {
    await fsp.mkdir(staging, { recursive: true });
    const resolved = await extensionHost.resolve(song.extensionId, song, staging);
    if (!resolved.ok) throw new Error(resolved.error || resolved.result?.error || '扩展没有返回下载结果');
    const result = resolved.result || {};
    if (result.queued) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      job.status = 'success';
      job.queued = true;
      job.message = result.message || '已交给平台下载队列';
      postHostEvent('extension-download', { id: job.id, status: 'success', name: job.name, queued: true });
      return job;
    }
    const sourceFile = path.resolve(String(result.file || ''));
    if (!sourceFile.startsWith(path.resolve(staging) + path.sep) || !fs.existsSync(sourceFile)) throw new Error('扩展返回的下载文件无效');
    const targetDir = extensionDownloadDir();
    if (!targetDir) throw new Error('没有配置音乐库目录');
    await fsp.mkdir(targetDir, { recursive: true });
    const ext = path.extname(sourceFile).toLowerCase();
    const title = safeFileName(result.title || job.name);
    const artist = safeFileName(result.artist || job.artist);
    const base = (artist ? artist + ' - ' : '') + title;
    let target = path.join(targetDir, base + ext);
    let suffix = 1;
    while (fs.existsSync(target)) target = path.join(targetDir, base + ' (' + (++suffix) + ')' + ext);
    try { await fsp.rename(sourceFile, target); }
    catch { await fsp.copyFile(sourceFile, target); await fsp.unlink(sourceFile).catch(() => {}); }
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await provenanceStore.record(target, {
      source: song.source || song.extensionId || job.source,
      title: result.title || job.name,
      artist: result.artist || job.artist,
    });
    job.status = 'success';
    job.path = target;
    postHostEvent('extension-download', { id: job.id, status: 'success', name: job.name, path: target });
    await refreshLibrarySoon();
    postHostEvent('library-changed', { reason: 'extension-download' });
    return job;
  } catch (error) {
    job.status = 'error';
    job.error = error.message;
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    postHostEvent('extension-download', { id: job.id, status: 'error', name: job.name, error: error.message });
    return job;
  }
}
function startExtensionDownloads(songs) {
  for (const song of songs) downloadExtensionSong(song).catch(() => {});
}
async function getExtensionDownloads() {
  return { jobs: Array.from(localDownloads.values()).slice(-100).reverse() };
}
async function getSources() {
  const data = await extensionStore.list()
  return { sources: buildSourceRegistry(data.extensions) }
}





