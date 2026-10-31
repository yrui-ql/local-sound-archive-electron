import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const SOURCE = 'netease'
const extensionDir = process.env.LSA_EXTENSION_DIR || process.cwd()
const dataDir = process.env.LSA_DATA_DIR || path.resolve(extensionDir, '..', '..')
const backend = process.env.LSA_BACKEND_URL || 'http://127.0.0.1:18088'
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

function credentials() {
  for (const file of [process.env.LSA_ADMIN_CREDENTIALS, path.join(dataDir, 'admin-credentials.txt')].filter(Boolean)) {
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
  const admin = credentials()
  if (!admin) throw new Error('找不到本机下载服务管理员凭据')
  const response = await fetch(backend + '/music/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ next: '/music', username: admin.username, password: admin.password }),
  })
  const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')]
  const cookie = raw.filter(Boolean).map((value) => value.split(';')[0]).join('; ')
  if (!cookie) throw new Error('本机下载服务登录失败')
  return cookie
}

async function request(cookie, pathname, options = {}) {
  const response = await fetch(backend + pathname, {
    ...options,
    headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) },
  })
  return { response, text: await response.text() }
}

function decode(value) {
  return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}
function attrs(block) {
  const out = {}
  for (const match of block.matchAll(/data-([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) out[match[1]] = decode(match[2] ?? match[3] ?? '')
  return out
}
function songsFrom(html) {
  const out = []
  for (const block of html.split(/<li class="song-card"/).slice(1)) {
    const a = attrs(block.slice(0, block.indexOf('>') + 1))
    if (!a.id || a.source !== SOURCE) continue
    out.push({
      id: a.id, source: SOURCE, title: a.name || '未知歌曲', name: a.name || '未知歌曲',
      artist: a.artist || '未知歌手', album: a.album || '', cover: a.cover || '',
      duration: Number(a.duration) || 0, extra: a.extra || '{}',
    })
  }
  return out
}
function playlistsFrom(html) {
  const out = []
  for (const block of html.split('<div class="playlist-card"').slice(1)) {
    const a = attrs(block)
    if (!a['external-id']) continue
    const title = ((block.match(/<div class="playlist-title">\s*([\s\S]*?)\s*<a /) || [])[1] || '').replace(/<[^>]+>/g, '').trim()
    out.push({ id: a['external-id'], title: title || a.name || '', link: a.link || '' })
  }
  return out
}

async function authBegin() {
  const cookie = await login()
  const result = await request(cookie, '/music/qr_login/' + SOURCE, { method: 'POST' })
  if (!result.response.ok) throw new Error('创建二维码失败 HTTP ' + result.response.status)
  const data = JSON.parse(result.text || '{}')
  if (!data.key || !data.url) throw new Error('二维码数据不完整')
  return { ok: true, status: 'waiting', source: SOURCE, key: data.key, url: data.url, message: '请打开网易云音乐扫码' }
}

async function authPoll(key) {
  if (!key) throw new Error('二维码会话无效')
  const cookie = await login()
  const result = await request(cookie, '/music/qr_login/' + SOURCE + '?key=' + encodeURIComponent(key))
  if (!result.response.ok) throw new Error('检查登录状态失败 HTTP ' + result.response.status)
  const data = JSON.parse(result.text || '{}')
  if (data.status !== 'success') return { ok: true, status: data.status || 'waiting', message: data.message || '' }
  const value = data.cookie || (data.cookies ? JSON.stringify(data.cookies) : '')
  if (!value) throw new Error('登录成功但没有拿到 Cookie')
  const saved = await request(cookie, '/music/cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [SOURCE]: typeof value === 'string' ? value : JSON.stringify(value) }),
  })
  if (!saved.response.ok) throw new Error('保存登录态失败')
  return { ok: true, status: 'success', message: '登录成功' }
}

async function readyCookie() {
  const cookie = await login()
  const status = await request(cookie, '/music/cookies')
  if (!new RegExp('"' + SOURCE + '"\\s*:\\s*"[^"]+').test(status.text)) throw new Error('网易云未登录，请先扫码')
  return cookie
}

async function search(query, limit = 30) {
  const cookie = await readyCookie()
  const result = await request(cookie, '/music/search?q=' + encodeURIComponent(query) + '&type=song&sources=' + SOURCE + '&page=1&page_size=' + Math.max(1, Math.min(50, limit)))
  if (!result.response.ok) throw new Error('搜索失败 HTTP ' + result.response.status)
  return songsFrom(result.text).map((song) => ({ ...song, extensionId: SOURCE }))
}

async function resolve(song) {
  const cookie = await readyCookie()
  const result = await request(cookie, '/music/api/downloads/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: crypto.randomUUID(),
      songs: [{ id: String(song.id || ''), source: SOURCE, name: song.name || '', artist: song.artist || '', album: song.album || '', cover: song.cover || '', extra: song.extra || '{}', embed: false }],
    }),
  })
  if (!result.response.ok) throw new Error('加入下载队列失败 HTTP ' + result.response.status)
  return { queued: true, message: '已交给网易云下载队列' }
}

async function likesList() {
  const cookie = await readyCookie()
  const list = await request(cookie, '/music/user_playlists?sources=' + SOURCE)
  const playlist = playlistsFrom(list.text).find((item) => /喜欢/.test(item.title))
  if (!playlist) throw new Error('没有找到网易云“喜欢”歌单')
  const songs = []
  for (let page = 1; page <= 10; page++) {
    const result = await request(cookie, '/music/playlist?id=' + encodeURIComponent(playlist.id) + '&source=' + SOURCE + '&link=' + encodeURIComponent(playlist.link) + '&name=' + encodeURIComponent(playlist.title) + '&page=' + page)
    if (!result.response.ok) break
    const parsed = songsFrom(result.text)
    if (!parsed.length) break
    songs.push(...parsed)
  }
  return { playlist: playlist.title, songs }
}

async function likesSync(jobId = 'likes-sync') {
  const cookie = await readyCookie()
  const list = await likesList()
  const statePath = path.join(extensionDir, 'likes-state.json')
  let seen = []
  try { seen = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')).seen || [] } catch {}
  const seenSet = new Set(seen)
  const fresh = list.songs.filter((song) => song.id && !seenSet.has(song.id))
  let queued = 0
  for (let i = 0; i < fresh.length; i += 50) {
    const batch = fresh.slice(i, i + 50).map((song) => ({ id: song.id, source: SOURCE, name: song.name, artist: song.artist, album: song.album || '', cover: song.cover || '', extra: song.extra || '{}', embed: false }))
    const result = await request(cookie, '/music/api/downloads/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: crypto.randomUUID(), songs: batch }) })
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
      name: '网易云音乐（扩展）', version: '0.1.0',
      capabilities: ['search', 'resolve', 'auth', 'likes', 'scheduler', 'health'],
      sources: [{ id: SOURCE, name: '网易云音乐', auth: ['qr'], likes: true }],
      jobs: [{ id: 'likes-sync', title: '网易云喜欢同步' }],
    })
    if (request.method === 'health') return send(request.id, { ok: true, credentials: !!credentials() })
    if (request.method === 'auth.begin') return send(request.id, await authBegin())
    if (request.method === 'auth.poll') return send(request.id, await authPoll(request.params?.key))
    if (request.method === 'search') return send(request.id, { songs: await search(String(request.params?.query || ''), request.params?.limit) })
    if (request.method === 'resolve') return send(request.id, await resolve(request.params?.song || {}))
    if (request.method === 'likes.list') return send(request.id, await likesList())
    if (request.method === 'likes.sync') return send(request.id, await likesSync('manual'))
    if (request.method === 'job.run') return send(request.id, await likesSync(request.params?.jobId || 'likes-sync'))
    send(request.id, { ok: false, error: 'unknown method: ' + request.method })
  } catch (error) {
    send(request.id, { ok: false, error: error.message || String(error) })
  }
})
