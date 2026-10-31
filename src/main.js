const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, session } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { LibraryStore } = require('./library')
const { ExtensionStore } = require('./extensions')
const { ExtensionHost } = require('./extension-host')
const { LikesStore } = require('./likes')
const { AccountService } = require('./account')

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
let accountService = null

async function loadConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  if (!libraryStore) libraryStore = new LibraryStore(path.join(DATA_DIR, 'library.db'))
  if (!extensionStore) extensionStore = new ExtensionStore(path.join(DATA_DIR, 'extensions'), path.join(APP_ROOT, 'extension-sdk', 'sample-source'))
  if (!extensionHost) extensionHost = new ExtensionHost(extensionStore)
  if (!likesStore) likesStore = new LikesStore(DATA_DIR, BACKEND_URL)
  if (!accountService) accountService = new AccountService(DATA_DIR, BACKEND_URL)
  try {
    if (fs.existsSync(CONFIG_PATH)) config = JSON.parse((await fsp.readFile(CONFIG_PATH, 'utf8')).replace(/^\uFEFF/, ''))
  } catch { config = {} }
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
    backendAvailable = true
    return { queue: recalculateQueue(queue, visibleQueueTasks(Array.isArray(queue.tasks) ? queue.tasks : [])), records }
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
    { id: 'codex', name: 'Codex', command: 'codex', kind: 'cli' },
    { id: 'claude', name: 'Claude Code', command: 'claude', kind: 'cli' },
    { id: 'dsh', name: 'DSH', command: 'dsh', kind: 'cli', env: 'DSH_CLI' },
    { id: 'cursor', name: 'Cursor', command: 'cursor', kind: 'gui' },
  ]
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  return {
    agents: candidates.map((agent) => {
      const candidatesPath = []
      const envPath = agent.env ? process.env[agent.env] : ''
      if (envPath) candidatesPath.push(envPath)
      for (const dir of pathDirs) {
        candidatesPath.push(path.join(dir, process.platform === 'win32' ? agent.command + '.cmd' : agent.command))
        candidatesPath.push(path.join(dir, process.platform === 'win32' ? agent.command + '.exe' : agent.command))
      }
      if (agent.id === 'cursor' && process.platform === 'win32') {
        candidatesPath.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor', 'Cursor.exe'))
        candidatesPath.push(path.join(APP_ROOT, '..', '..', '01_ENV', '20_ai', 'cursor', 'app', 'Cursor.exe'))
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

async function listRecordings() {
  await fsp.mkdir(recordingsDir(), { recursive: true }).catch(() => {})
  const files = []
  try {
    for (const entry of await fsp.readdir(recordingsDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(webm|wav|mp3|m4a)$/i.test(entry.name)) continue
      const file = path.join(recordingsDir(), entry.name)
      const stat = await fsp.stat(file)
      files.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs })
    }
  } catch { }
  return { files: files.sort((a, b) => b.mtime - a.mtime), dir: recordingsDir() }
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
      return listRecordings()
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
































