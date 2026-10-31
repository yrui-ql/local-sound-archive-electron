#!/usr/bin/env node
/**
 * 跨平台「我喜欢的音乐」定时增量同步。
 *
 * 数据：
 *   - 03_DATA/50_music/likes-sync.json          （配置，客户端读写）
 *   - 03_DATA/50_music/likes/state-<src>.json   （每平台上次红心快照）
 *   - 03_DATA/50_music/likes/events.json        （时间线，最近 300 条）
 *   - 03_DATA/50_music/likes/last-run.json      （最近一次结果，供宿主判断自动整理）
 *   - 音乐库目录\_报告\喜欢同步-*.md / 最新喜欢同步.md
 *
 * 首次同步默认只建基线，不批量下载历史；config.backfill=true 时补齐历史中未入库的。
 * 之后每个平台只把「新增红心」加入 go-music-dl 下载队列；取消喜欢的只记录，不删本地文件。
 *
 * node .agents/scripts/sync-liked-music.mjs --apply
 * node .agents/scripts/sync-liked-music.mjs --dry-run
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = path.dirname(fileURLToPath(import.meta.url))
const WS = path.resolve(here, '..')
const BASE = process.env.LSA_BACKEND_URL || 'http://127.0.0.1:18088'
const DATA = process.env.LSA_DATA_DIR ? path.resolve(process.env.LSA_DATA_DIR) : path.join(WS, 'data')
const LIKES_DIR = path.join(DATA, 'likes')
const CONFIG_PATH = path.join(DATA, 'likes-sync.json')
const EVENTS_PATH = path.join(LIKES_DIR, 'events.json')
const LAST_RUN_PATH = path.join(LIKES_DIR, 'last-run.json')
const CRED_PATH = path.join(DATA, 'admin-credentials.txt')
const CLIENT_CONFIG_PATH = path.join(DATA, 'config.json')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const onlyArg = args.find((a) => a.startsWith('--only='))
const only = onlyArg ? onlyArg.slice('--only='.length) : null

const SOURCE_META = {
  soda: { name: '汽水音乐', connector: 'soda' },
  netease: { name: '网易云音乐', connector: 'netease' },
  qq: { name: 'QQ 音乐', connector: 'qq' },
}
const SOURCE_IDS = ['soda', 'netease', 'qq']
const BATCH = 100
const log = (m) => console.log('[likes] ' + m)

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}
function loadConfig() {
  const cfg = readJson(CONFIG_PATH, {})
  return {
    enabled: cfg.enabled !== false,
    intervalHours: Math.max(1, Math.min(24 * 30, Number(cfg.intervalHours) || 24)),
    backfill: cfg.backfill === true,
    autoImport: cfg.autoImport !== false,
    generateReport: cfg.generateReport === true,
    sources: Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources.filter((s) => SOURCE_IDS.includes(s)) : SOURCE_IDS,
  }
}
function readCred() {
  try {
    const t = fs.readFileSync(CRED_PATH, 'utf8')
    const u = t.match(/^username=(.+)$/m)?.[1]?.trim()
    const p = t.match(/^password=(.+)$/m)?.[1]?.trim()
    return u && p ? [u, p] : null
  } catch { return null }
}
function readClientConfig() { return readJson(CLIENT_CONFIG_PATH, {}) }
function htmlDecode(s) {
  return String(s || '').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
function parseAttrs(block) {
  const attrs = {}
  for (const m of block.matchAll(/data-([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = htmlDecode(m[2] ?? m[3] ?? '')
  return attrs
}
function parseSongCards(html) {
  const out = []
  for (const raw of html.split(/<li class="song-card"/).slice(1)) {
    const a = parseAttrs(raw.slice(0, raw.indexOf('>') + 1))
    if (!a.id || !a.source) continue
    out.push({ id: a.id, source: a.source, name: a.name || '', artist: a.artist || '', album: a.album || '', cover: a.cover || '', extra: a.extra || '{}' })
  }
  return out
}
function parsePlaylistCards(html) {
  const out = []
  for (const b of html.split('<div class="playlist-card"').slice(1)) {
    const a = parseAttrs(b)
    if (!a['external-id']) continue
    const title = ((b.match(/<div class="playlist-title">\s*([\s\S]*?)\s*<a /) || [])[1] || '').replace(/<[^>]+>/g, '').trim()
    out.push({ title: title || a.name || '', id: a['external-id'], link: a.link || '', source: a.source || '', count: a['track-count'] || '', name: a.name || title || '' })
  }
  return out
}
function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[（）()\[\]【】「」"'“”‘’·•\-_.]/g, '') }
function loadOwned() {
  const set = new Set()
  try {
    const db = new DatabaseSync(path.join(DATA, 'library.db'))
    for (const row of db.prepare('SELECT title, artist FROM tracks').all()) {
      if (row.title && row.artist) set.add(norm(row.artist) + '|' + norm(row.title))
    }
    db.close()
  } catch { }
  return set
}
function loadState(source) { return readJson(path.join(LIKES_DIR, 'state-' + source + '.json'), null) }
function saveState(source, state) { writeJson(path.join(LIKES_DIR, 'state-' + source + '.json'), state) }
function loadEvents() { const e = readJson(EVENTS_PATH, []); return Array.isArray(e) ? e : [] }
function appendEvents(events) {
  const all = loadEvents()
  all.push(...events)
  writeJson(EVENTS_PATH, all.slice(-300))
}
function sourceLabel(s) { return SOURCE_META[s]?.name || s }
function formatNow() { return new Date().toISOString() }
async function login() {
  const cred = readCred()
  if (!cred) throw new Error('找不到本机管理员凭据，先打开客户端初始化')
  const r = await fetch(BASE + '/music/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ next: '/music', username: cred[0], password: cred[1] }),
  })
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean)).map((x) => x.split(';')[0]).join('; ')
  if (!cookie) throw new Error('管理员登录失败')
  return cookie
}
async function get(cookie, url) { return (await fetch(BASE + url, { headers: { Cookie: cookie } })).text() }
async function post(cookie, url, body) {
  return fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie }, body: JSON.stringify(body),
  })
}
async function refreshSodaCookie() { return { ok: false, reason: '汽水客户端登录态需由平台设置提供' } }

async function processSource(source, cookie, cookies, config) {
  const meta = SOURCE_META[source]
  const connected = !!cookies[source]
  if (!connected) {
    return { source, status: 'skipped', connected: false, message: '未配置登录态，去设置里登录', likedTotal: 0, newCount: 0, queued: 0, ownedSkipped: 0, removedCount: 0, added: [], removed: [], likedPlaylist: null }
  }
  log(sourceLabel(source) + '：读取我的歌单…')
  const listHtml = await get(cookie, '/music/user_playlists?sources=' + encodeURIComponent(source))
  const playlists = parsePlaylistCards(listHtml).filter((p) => !p.source || p.source === source)
  if (!playlists.length) {
    const cookieMissing = /category-source-empty[^>]*error|require cookie/i.test(listHtml)
    return { source, status: 'skipped', connected: !cookieMissing, message: cookieMissing ? '需要登录态' : '没有读到个人歌单', likedTotal: 0, newCount: 0, queued: 0, ownedSkipped: 0, removedCount: 0, added: [], removed: [], likedPlaylist: null }
  }
  const liked = playlists.find((p) => /(我?喜欢|我喜歡|liked)/i.test(p.title) && !/收藏的歌单/.test(p.title)) || playlists.find((p) => /(我?喜欢|我喜歡|liked)/i.test(p.title))
  if (!liked) {
    return { source, status: 'error', connected: true, message: '没有找到“喜欢”歌单', likedTotal: 0, newCount: 0, queued: 0, ownedSkipped: 0, removedCount: 0, added: [], removed: [], likedPlaylist: null }
  }
  log(sourceLabel(source) + '：歌单「' + liked.title + '」，读取歌曲…')
  const songs = []
  const seen = new Set()
  let pages = 1
  for (let page = 1; page <= pages; page++) {
    const url = '/music/playlist?id=' + encodeURIComponent(liked.id) + '&source=' + encodeURIComponent(liked.source || source) +
      '&link=' + encodeURIComponent(liked.link || '') + '&name=' + encodeURIComponent(liked.title) + '&page=' + page
    const html = await get(cookie, url)
    if (page === 1) {
      const m = html.match(/data-total-pages="(\d+)"/)
      if (m) pages = Math.max(1, Math.min(200, parseInt(m[1], 10)))
    }
    const pageSongs = parseSongCards(html)
    for (const s of pageSongs) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      songs.push(s)
    }
    log(sourceLabel(source) + '：歌单页 ' + page + '/' + pages + '，累计 ' + songs.length + ' 首')
    if (!pageSongs.length) break
  }

  const previous = loadState(source)
  const first = !previous || !Array.isArray(previous.seenIds)
  const prevIds = new Set(first ? [] : previous.seenIds)
  const currentIds = songs.map((s) => s.id)
  const currentSet = new Set(currentIds)
  const removedIds = first ? [] : previous.seenIds.filter((id) => !currentSet.has(id))
  const removedSongs = first ? [] : removedIds.map((id) => previous.seen?.find?.((s) => s.id === id)).filter(Boolean).map((s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album || '' }))
  const removedTitles = removedSongs.map((s) => s.title + ' / ' + s.artist)
  let candidates = first ? [] : songs.filter((s) => !prevIds.has(s.id))
  const shouldBackfill = config.backfill && (!previous || !previous.backfilled)
  if (shouldBackfill) candidates = songs.slice()
  const owned = loadOwned()
  const queuedKeys = new Set()
  const toQueue = []
  let ownedSkipped = 0
  for (const s of candidates) {
    // 汽水用户原声（UGC）由 soda-ugc.mjs 走专用签名下载；不要再交给普通下载器排队。
    if (s.source === 'soda' && /(创作的原声|创作原声|直播回放|原声片段)/.test(String(s.name || ''))) continue
    const key = norm(s.artist) + '|' + norm(s.name)
    if (owned.has(key) || queuedKeys.has(key)) { ownedSkipped++; continue }
    queuedKeys.add(key)
    toQueue.push(s)
  }
  let queued = 0
  const added = []
  if (!dryRun && toQueue.length) {
    for (let i = 0; i < toQueue.length; i += BATCH) {
      const batch = toQueue.slice(i, i + BATCH).map((s) => ({ id: s.id, source: s.source, name: s.name, artist: s.artist, album: s.album, cover: s.cover, extra: s.extra || '{}', embed: false }))
      const r = await post(cookie, '/music/api/downloads/queue', { request_id: crypto.randomUUID(), songs: batch })
      const text = await r.text()
      if (!r.ok) throw new Error('加入下载队列失败 HTTP ' + r.status + '：' + text.slice(0, 200))
      const m = text.match(/"added"\s*:\s*(\d+)/)
      queued += m ? parseInt(m[1], 10) : batch.length
      log(sourceLabel(source) + '：已入队 ' + Math.min(i + BATCH, toQueue.length) + '/' + toQueue.length)
    }
    added.push(...toQueue.slice(0, 80).map((s) => ({ title: s.name, artist: s.artist })))
  } else {
    added.push(...toQueue.slice(0, 80).map((s) => ({ title: s.name, artist: s.artist })))
  }
  const status = first ? 'baseline' : 'ok'
  let message = first
    ? (shouldBackfill ? '首次同步：补齐历史喜欢 ' + toQueue.length + ' 首' : '首次同步：建立基线，不下载历史；可开启「补齐历史」')
    : (toQueue.length ? '新增喜欢 ' + toQueue.length + ' 首' : '没有新增喜欢')
  if (!dryRun) {
    saveState(source, {
      source,
      lastSync: formatNow(),
      likedPlaylist: { id: liked.id, title: liked.title, link: liked.link },
      likedTotal: songs.length,
      seenIds: currentIds,
      seen: songs.map((s) => ({ id: s.id, title: s.name, artist: s.artist })),
      backfilled: !!previous?.backfilled || shouldBackfill,
    })
  }
  log(sourceLabel(source) + '：' + message)
  return { source, status, connected: true, message, likedTotal: songs.length, newCount: toQueue.length, queued, ownedSkipped, removedCount: removedIds.length, added, removed: removedTitles.slice(0, 40), removedSongs: removedSongs.slice(0, 40), likedPlaylist: { id: liked.id, title: liked.title } }
}

async function main() {
  const config = loadConfig()
  const cookie = await login()
  const cookiesJson = JSON.parse(await get(cookie, '/music/cookies') || '{}')
  const cookies = {}
  for (const s of SOURCE_IDS) cookies[s] = typeof cookiesJson[s] === 'string' ? cookiesJson[s].trim().length > 0 : false
  const sodaRefresh = await refreshSodaCookie(cookie)
  if (sodaRefresh.ok) cookies.soda = true
  else if (!cookies.soda) log('汽水：' + sodaRefresh.reason)
  const sources = (only ? [only] : config.sources).filter((s) => SOURCE_IDS.includes(s))
  log('本次来源：' + sources.join(' / ') + (dryRun ? '（dry-run）' : ''))
  const results = []
  for (const source of sources) {
    try { results.push(await processSource(source, cookie, cookies, config)) }
    catch (e) { results.push({ source, status: 'error', connected: !!cookies[source], message: e.message, likedTotal: 0, newCount: 0, queued: 0, ownedSkipped: 0, removedCount: 0, added: [], removed: [], likedPlaylist: null }) }
  }
  const totalQueued = results.reduce((n, r) => n + (r.queued || 0), 0)
  const events = results.map((r) => ({
    at: formatNow(), source: r.source, status: r.status, message: r.message,
    likedTotal: r.likedTotal || 0, newCount: r.newCount || 0, queued: r.queued || 0,
    ownedSkipped: r.ownedSkipped || 0, removedCount: r.removedCount || 0,
    added: r.added || [], removed: r.removed || [],
  }))
  if (!dryRun) {
    appendEvents(events)
    let reportPath = null
    if (config.generateReport) {
      const reportDir = path.join(readClientConfig().libraryRoot || path.join(DATA, 'library'), '_报告')
      fs.mkdirSync(reportDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const lines = [
        '# 喜欢同步报告', '',
        '- 时间：' + new Date().toISOString(),
        '- 来源：' + sources.join(' / '),
        '- 本次新增入队：' + totalQueued + ' 首',
        '', '| 平台 | 状态 | 喜欢总数 | 新增 | 入队 | 库内已有跳过 | 取消喜欢 |', '|---|---|---:|---:|---:|---:|---:|',
        ...results.map((r) => '| ' + [sourceLabel(r.source), r.status, r.likedTotal || 0, r.newCount || 0, r.queued || 0, r.ownedSkipped || 0, r.removedCount || 0].join(' | ') + ' |'),
        '', '## 新增喜欢', '',
        ...results.flatMap((r) => (r.added || []).length ? ['### ' + sourceLabel(r.source), ...r.added.map((s) => '- ' + s.title + ' — ' + s.artist)] : []),
        '', '> 首次同步默认只建立基线；开启「补齐历史喜欢」后，会把历史中未入库的加入下载。取消喜欢只记录，不删除本地文件。',
      ]
      reportPath = path.join(reportDir, '喜欢同步-' + stamp + '.md')
      fs.writeFileSync(reportPath, '\uFEFF' + lines.join('\n'), 'utf8')
      fs.writeFileSync(path.join(reportDir, '最新喜欢同步.md'), '\uFEFF' + lines.join('\n'), 'utf8')
    }
    writeJson(LAST_RUN_PATH, { at: formatNow(), queued: totalQueued, report: reportPath, results })
    log('完成：新增入队 ' + totalQueued + ' 首' + (reportPath ? '；报告 ' + reportPath : '；未生成报告（设置未开启）'))
    if (sources.includes('soda') && process.env.MUSIC_SKIP_SODA_UGC !== '1') {
      try {
        log('补下汽水用户原声…')
        spawnSync(process.execPath, [path.join(here, 'soda-ugc.mjs'), '--apply'], {
          cwd: WS, stdio: 'inherit', timeout: 20 * 60 * 1000,
        })
      } catch (e) {
        log('原声补下跳过：' + e.message)
      }
    }
  } else {
    console.log(JSON.stringify({ dryRun: true, sources, results }, null, 2))
  }
}

main().catch((e) => {
  console.error('[likes] ❌ ' + e.message)
  process.exit(1)
})

