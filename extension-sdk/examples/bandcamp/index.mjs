import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import readline from 'node:readline'

const run = promisify(execFile)
const proxy = process.env.LSA_PROXY || process.env.HTTPS_PROXY || 'http://127.0.0.1:7897'
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

async function fetchText(url, options = {}) {
  if (proxy) {
    try {
      const args = ['-sS', '-L', '--max-time', '35', '-x', proxy, '-X', options.method || 'GET', '-H', 'User-Agent: Mozilla/5.0']
      for (const [key, value] of Object.entries(options.headers || {})) args.push('-H', key + ': ' + value)
      if (options.body) args.push('--data-binary', options.body)
      args.push(url)
      const { stdout } = await run(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { maxBuffer: 30 * 1024 * 1024 })
      return stdout
    } catch {}
  }
  const response = await fetch(url, { ...options, headers: { 'User-Agent': 'Mozilla/5.0', ...(options.headers || {}) } })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return response.text()
}

async function search(query, limit = 20) {
  const body = JSON.stringify({ search_text: query, search_filter: 'a', full_page: true, fan_id: null })
  const text = await fetchText('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const data = JSON.parse(text)
  const results = data.auto?.results || []
  return results.slice(0, Math.max(1, Math.min(40, limit))).map((item) => ({
    id: String(item.item_url_path || item.item_url_root || item.id),
    source: 'bandcamp',
    title: item.name || '未知专辑',
    artist: item.band_name || '',
    album: item.name || '',
    cover: item.img || '',
    duration: 0,
    extra: JSON.stringify({ url: item.item_url_path || item.item_url_root || '', type: item.type || 'a' }),
    extensionId: 'bandcamp',
  }))
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  try {
    if (request.method === 'describe') return send(request.id, {
      name: 'Bandcamp 元数据', version: '0.1.0',
      capabilities: ['search', 'resolve', 'health'],
      sources: [{ id: 'bandcamp', name: 'Bandcamp', auth: [], likes: false, metadataOnly: true }],
    })
    if (request.method === 'health') return send(request.id, { ok: true, proxy: !!proxy })
    if (request.method === 'search') return send(request.id, { songs: await search(String(request.params?.query || ''), request.params?.limit) })
    if (request.method === 'resolve') return send(request.id, { ok: false, error: 'Bandcamp 仅提供目录元数据；购买文件请放入本地音乐库。' })
    send(request.id, { ok: false, error: 'unknown method: ' + request.method })
  } catch (error) {
    send(request.id, { ok: false, error: error.message || String(error) })
  }
})
