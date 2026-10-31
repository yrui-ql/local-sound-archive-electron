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

function spotifyId(value) {
  const match = String(value || '').match(/spotify\.com\/(playlist|album|track)\/([A-Za-z0-9]+)/)
  if (match) return { type: match[1], id: match[2] }
  const uri = String(value || '').match(/spotify:(playlist|album|track):([A-Za-z0-9]+)/)
  if (uri) return { type: uri[1], id: uri[2] }
  return null
}

async function importPlaylist(url) {
  const parsed = spotifyId(url)
  if (!parsed) throw new Error('请输入 Spotify 歌单链接')
  const html = await fetchText('https://open.spotify.com/embed/' + parsed.type + '/' + parsed.id)
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('Spotify 页面格式无法读取')
  const data = JSON.parse(match[1])
  const page = data.props?.pageProps || {}
  if (page.status && page.status !== 200) throw new Error('Spotify 返回状态 ' + page.status)
  const entity = page.state?.data?.entity || {}
  const tracks = (entity.trackList || []).map((track) => ({
    id: String(track.uri || '').split(':').pop(),
    source: 'spotify',
    title: track.title || '未知曲目',
    artist: track.subtitle || '未知歌手',
    album: entity.title || entity.name || '',
    cover: entity.coverArt?.sources?.[0]?.url || '',
    duration: Math.round((Number(track.duration) || 0) / 1000),
    extra: JSON.stringify({ uri: track.uri || '', preview: track.audioPreview?.url || '' }),
    extensionId: 'spotify',
  }))
  return {
    playlist: {
      id: parsed.id,
      type: parsed.type,
      title: entity.title || entity.name || 'Spotify',
      cover: entity.coverArt?.sources?.[0]?.url || '',
      url,
    },
    tracks,
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  try {
    if (request.method === 'describe') return send(request.id, {
      name: 'Spotify 元数据', version: '0.1.0',
      capabilities: ['playlist', 'resolve', 'health'],
      sources: [{ id: 'spotify', name: 'Spotify', auth: [], likes: false, metadataOnly: true }],
    })
    if (request.method === 'health') return send(request.id, { ok: true, proxy: !!proxy })
    if (request.method === 'playlist.import') return send(request.id, { ok: true, ...(await importPlaylist(String(request.params?.url || ''))) })
    if (request.method === 'resolve') return send(request.id, { ok: false, error: 'Spotify 仅支持元数据和歌单导入；不提供 DRM 音频下载。' })
    send(request.id, { ok: false, error: 'unknown method: ' + request.method })
  } catch (error) {
    send(request.id, { ok: false, error: error.message || String(error) })
  }
})
