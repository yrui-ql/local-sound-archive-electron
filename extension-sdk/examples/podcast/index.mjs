import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const extensionDir = process.env.LSA_EXTENSION_DIR || process.cwd()
const statePath = path.join(extensionDir, 'feeds.json')
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''))
    return { feeds: Array.isArray(value.feeds) ? value.feeds : [] }
  } catch { return { feeds: [] } }
}
async function saveState(state) {
  await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
}
function text(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
function tag(xml, name) {
  const match = String(xml || '').match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'))
  return match ? text(match[1]) : ''
}
function attr(xml, name) {
  const match = String(xml || '').match(new RegExp(name + '="([^"]*)"', 'i'))
  return match ? match[1] : ''
}
function parseFeed(xml, feedUrl) {
  const title = tag(xml, 'title') || feedUrl
  const items = []
  for (const match of String(xml).matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]
    const enclosure = (block.match(/<enclosure[^>]*url="([^"]+)"/i) || [])[1] || ''
    const link = tag(block, 'link') || ''
    const audio = enclosure || link
    if (!audio) continue
    items.push({
      title: tag(block, 'title') || '未命名单集',
      url: audio,
      publishedAt: tag(block, 'pubDate') || '',
      duration: Number(tag(block, 'itunes:duration').replace(/:/g, '') || 0) || 0,
      description: tag(block, 'description').slice(0, 220),
    })
  }
  return { id: feedUrl, title, url: feedUrl, fetchedAt: new Date().toISOString(), episodes: items.slice(0, 120) }
}

async function fetchFeed(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'LSA/3.0 Podcast RSS' } })
  if (!response.ok) throw new Error('RSS 请求失败 HTTP ' + response.status)
  return parseFeed(await response.text(), url)
}

async function feedList() {
  const state = readState()
  return { feeds: state.feeds }
}
async function feedAdd(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('请输入 http/https RSS 地址')
  const state = readState()
  const feed = await fetchFeed(url)
  state.feeds = state.feeds.filter((item) => item.url !== feed.url)
  state.feeds.unshift(feed)
  state.feeds = state.feeds.slice(0, 50)
  await saveState(state)
  return { ok: true, feed }
}
async function feedRefresh(url) {
  const state = readState()
  const index = state.feeds.findIndex((item) => item.url === url)
  if (index < 0) throw new Error('没有这个订阅')
  state.feeds[index] = await fetchFeed(url)
  await saveState(state)
  return { ok: true, feed: state.feeds[index] }
}
async function feedRemove(url) {
  const state = readState()
  state.feeds = state.feeds.filter((item) => item.url !== url)
  await saveState(state)
  return { ok: true }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  try {
    if (request.method === 'describe') return send(request.id, {
      name: '播客 RSS', version: '0.1.0',
      capabilities: ['feed', 'resolve', 'health'],
      sources: [{ id: 'podcast-rss', name: '播客 RSS', auth: [], likes: false }],
    })
    if (request.method === 'health') return send(request.id, { ok: true })
    if (request.method === 'feed.list') return send(request.id, await feedList())
    if (request.method === 'feed.add') return send(request.id, await feedAdd(String(request.params?.url || '')))
    if (request.method === 'feed.refresh') return send(request.id, await feedRefresh(String(request.params?.url || '')))
    if (request.method === 'feed.remove') return send(request.id, await feedRemove(String(request.params?.url || '')))
    send(request.id, { ok: false, error: 'unknown method: ' + request.method })
  } catch (error) {
    send(request.id, { ok: false, error: error.message || String(error) })
  }
})

