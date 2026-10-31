import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import readline from 'node:readline'

const extensionDir = process.env.LSA_EXTENSION_DIR || process.cwd()
const dataDir = process.env.LSA_DATA_DIR || path.resolve(extensionDir, '..', '..')
const backend = process.env.LSA_BACKEND_URL || 'http://127.0.0.1:18088'
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

function adminCredentials() {
  const candidates = [
    process.env.LSA_ADMIN_CREDENTIALS,
    path.join(dataDir, 'admin-credentials.txt'),
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const username = (text.match(/^username=(.+)$/m) || [])[1]?.trim()
      const password = (text.match(/^password=(.+)$/m) || [])[1]?.trim()
      if (username && password) return { username, password }
    } catch {}
  }
  return null
}

async function login() {
  const credentials = adminCredentials()
  if (!credentials) throw new Error('找不到本机下载服务管理员凭据')
  const response = await fetch(backend + '/music/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ next: '/music', username: credentials.username, password: credentials.password }),
  })
  const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')]
  const cookie = raw.filter(Boolean).map((value) => value.split(';')[0]).join('; ')
  if (!cookie) throw new Error('本机下载服务登录失败')
  return cookie
}

function readSodaCookie() {
  const candidates = [
    process.env.SODA_COOKIE_DB,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'SodaMusic', 'Network', 'Cookies') : '',
    process.env.HOME ? path.join(process.env.HOME, 'Library', 'Application Support', 'SodaMusic', 'Network', 'Cookies') : '',
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      const db = new DatabaseSync(file, { readOnly: true })
      const rows = db.prepare("SELECT name, value FROM cookies WHERE host_key LIKE '%qishui.com' AND length(value) > 0").all()
      db.close()
      const seen = new Set()
      const parts = []
      for (const row of rows) {
        if (!row.value || seen.has(row.name)) continue
        seen.add(row.name)
        parts.push(row.name + '=' + row.value)
      }
      if (parts.length >= 8) return parts.join('; ')
    } catch {}
  }
  return ''
}

async function backendRequest(cookie, pathname, options = {}) {
  const response = await fetch(backend + pathname, {
    ...options,
    headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) },
  })
  return { response, text: await response.text() }
}

function htmlDecode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

function parseAttrs(block) {
  const attrs = {}
  for (const match of block.matchAll(/data-([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) attrs[match[1]] = htmlDecode(match[2] ?? match[3] ?? '')
  return attrs
}

function parseSongs(html) {
  const out = []
  for (const raw of html.split(/<li class="song-card"/).slice(1)) {
    const attrs = parseAttrs(raw.slice(0, raw.indexOf('>') + 1))
    if (!attrs.id || !attrs.source) continue
    out.push({
      id: attrs.id,
      source: attrs.source,
      title: attrs.name || '未知歌曲',
      name: attrs.name || '未知歌曲',
      artist: attrs.artist || '未知歌手',
      album: attrs.album || '',
      cover: attrs.cover || '',
      duration: Number(attrs.duration) || 0,
      extra: attrs.extra || '{}',
    })
  }
  return out
}

function parsePlaylistCards(html) {
  const out = []
  for (const block of html.split('<div class="playlist-card"').slice(1)) {
    const attrs = parseAttrs(block)
    if (!attrs['external-id']) continue
    const title = ((block.match(/<div class="playlist-title">\s*([\s\S]*?)\s*<a /) || [])[1] || '').replace(/<[^>]+>/g, '').trim()
    out.push({ title: title || attrs.name || '', id: attrs['external-id'], link: attrs.link || '', source: attrs.source || 'soda' })
  }
  return out
}

async function authorize(requireCookie = true) {
  const cookie = await login()
  if (!requireCookie) return cookie
  const sodaCookie = readSodaCookie()
  if (!sodaCookie) throw new Error('没有找到本机汽水客户端登录态，请先登录汽水客户端')
  const save = await backendRequest(cookie, '/music/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ soda: sodaCookie }),
  })
  if (!save.response.ok) throw new Error('写入汽水登录态失败 HTTP ' + save.response.status)
  return cookie
}

async function search(query, limit = 30) {
  const cookie = await authorize()
  const { response, text } = await backendRequest(cookie, '/music/search?q=' + encodeURIComponent(query) + '&type=song&page=1&page_size=' + Math.max(1, Math.min(50, limit)) + '&sources=soda')
  if (!response.ok) throw new Error('搜索服务 HTTP ' + response.status)
  return parseSongs(text).filter((song) => song.source === 'soda').map((song) => ({ ...song, extensionId: 'soda' }))
}

async function resolve(song) {
  const cookie = await authorize()
  const payload = {
    request_id: crypto.randomUUID(),
    songs: [{
      id: String(song.id || ''),
      source: 'soda',
      name: song.name || '',
      artist: song.artist || '',
      album: song.album || '',
      cover: song.cover || '',
      extra: typeof song.extra === 'string' ? song.extra : JSON.stringify(song.extra || {}),
      embed: false,
    }],
  }
  const result = await backendRequest(cookie, '/music/api/downloads/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!result.response.ok) throw new Error('加入下载队列失败 HTTP ' + result.response.status + '：' + result.text.slice(0, 160))
  return { queued: true, message: '已交给汽水下载队列' }
}

async function likesList() {
  const cookie = await authorize()
  const list = await backendRequest(cookie, '/music/user_playlists?sources=soda')
  const playlist = parsePlaylistCards(list.text).find((item) => /喜欢/.test(item.title))
  if (!playlist) throw new Error('没有找到汽水音乐“喜欢”歌单')
  const songs = []
  for (let page = 1; page <= 10; page++) {
    const result = await backendRequest(cookie, '/music/playlist?id=' + encodeURIComponent(playlist.id) + '&source=soda&link=' + encodeURIComponent(playlist.link) + '&name=' + encodeURIComponent(playlist.title) + '&page=' + page)
    if (!result.response.ok) break
    const pageSongs = parseSongs(result.text)
    if (!pageSongs.length) break
    songs.push(...pageSongs)
  }
  return { playlist: playlist.title, songs }
}

async function likesSync(jobId = 'likes-sync') {
  const cookie = await authorize()
  const list = await likesList()
  const statePath = path.join(extensionDir, 'likes-state.json')
  let seen = []
  try { seen = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')).seen || [] } catch {}
  const seenSet = new Set(seen)
  const fresh = list.songs.filter((song) => song.id && !seenSet.has(song.id))
  let queued = 0
  for (let i = 0; i < fresh.length; i += 50) {
    const batch = fresh.slice(i, i + 50).map((song) => ({
      id: song.id,
      source: 'soda',
      name: song.name,
      artist: song.artist,
      album: song.album || '',
      cover: song.cover || '',
      extra: song.extra || '{}',
      embed: false,
    }))
    const result = await backendRequest(cookie, '/music/api/downloads/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: crypto.randomUUID(), songs: batch }),
    })
    if (!result.response.ok) throw new Error('加入下载队列失败 HTTP ' + result.response.status)
    const match = result.text.match(/"added"\s*:\s*(\d+)/)
    queued += match ? Number(match[1]) : batch.length
  }
  const allSeen = [...new Set([...list.songs.map((song) => song.id).filter(Boolean), ...seen])].slice(-5000)
  await fs.promises.writeFile(statePath, JSON.stringify({ seen: allSeen, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  return { ok: true, jobId, playlist: list.playlist, total: list.songs.length, fresh: fresh.length, queued }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  try {
    if (request.method === 'describe') return send(request.id, {
      name: '汽水音乐（扩展）', version: '0.1.0',
      capabilities: ['search', 'resolve', 'auth', 'likes', 'scheduler', 'health'],
      sources: [{ id: 'soda', name: '汽水音乐', auth: ['cookie'], likes: true }],
      jobs: [{ id: 'likes-sync', title: '汽水喜欢同步' }],
    })
    if (request.method === 'health') {
      return send(request.id, { ok: true, cookie: !!readSodaCookie(), credentials: !!adminCredentials() })
    }
    if (request.method === 'auth.begin') {
      const cookie = await authorize()
      const status = await backendRequest(cookie, '/music/cookies')
      return send(request.id, { ok: true, status: 'success', message: '已读取本机汽水客户端登录态', cookies: status.text.slice(0, 200) })
    }
    if (request.method === 'auth.status') {
      const cookie = await login()
      const status = await backendRequest(cookie, '/music/cookies')
      return send(request.id, { ok: true, connected: /"soda"\s*:\s*"[^"]+/.test(status.text) })
    }
    if (request.method === 'search') {
      const songs = await search(String(request.params?.query || ''), request.params?.limit)
      return send(request.id, { songs })
    }
    if (request.method === 'resolve') return send(request.id, await resolve(request.params?.song || {}))
    if (request.method === 'likes.list') return send(request.id, await likesList())
    if (request.method === 'likes.sync') return send(request.id, await likesSync('manual'))
    if (request.method === 'job.run') return send(request.id, await likesSync(request.params?.jobId || 'likes-sync'))
    send(request.id, { ok: false, error: 'unknown method: ' + request.method })
  } catch (error) {
    send(request.id, { ok: false, error: error.message || String(error) })
  }
})
