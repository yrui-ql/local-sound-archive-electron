const path = require('node:path')
const { spawn } = require('node:child_process')

class ExtensionHost {
  constructor(store) {
    this.store = store
  }

  call(dir, manifest, method, params = {}, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const entry = path.join(dir, manifest.entry || 'index.mjs')
      const child = spawn(process.execPath, [entry], {
        cwd: dir,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LSA_EXTENSION_DIR: dir, LSA_DATA_DIR: process.env.LSA_DATA_DIR || '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let buffer = ''
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        try { child.kill() } catch { }
        resolve(value)
      }
      const timer = setTimeout(() => finish({ ok: false, error: '扩展响应超时' }), timeoutMs)
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString()
        for (const line of buffer.split('\n')) {
          if (!line.trim()) continue
          try {
            const message = JSON.parse(line)
            if (message.id === 1) {
              clearTimeout(timer)
              if (message.error) finish({ ok: false, error: message.error.message || '扩展错误' })
              else finish({ ok: true, result: message.result })
            }
          } catch { }
        }
      })
      child.on('error', (error) => { clearTimeout(timer); finish({ ok: false, error: error.message }) })
      child.on('exit', (code) => { if (!settled) { clearTimeout(timer); finish({ ok: false, error: '扩展退出码 ' + code }) } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
    })
  }

  async search(query) {
    const songs = []
    const errors = []
    const extensions = await this.store.enabled()
    for (const extension of extensions) {
      const capabilities = Array.isArray(extension.manifest.capabilities) ? extension.manifest.capabilities : []
      if (capabilities.length && !capabilities.includes('search')) continue
      const response = await this.call(extension.dir, extension.manifest, 'search', { query, limit: 15 }, 30000)
      if (!response.ok) { errors.push(extension.manifest.name + ': ' + response.error); continue }
      const list = response.result?.songs || []
      for (const song of list) songs.push({
        ...song,
        name: song.name || song.title || '未知歌曲',
        artist: song.artist || '未知歌手',
        source: song.source || extension.manifest.id,
        extensionId: extension.manifest.id,
      })
    }
    return { songs, count: songs.length, errors }
  }

  async resolve(extensionId, song, outputDir) {
    const extension = (await this.store.enabled()).find((item) => item.manifest.id === extensionId)
    if (!extension) return { ok: false, error: '扩展未启用：' + extensionId }
    const response = await this.call(extension.dir, extension.manifest, 'resolve', { song, outputDir }, 15 * 60 * 1000)
    if (!response.ok) return response
    return { ok: true, result: response.result }
  }

  async invoke(extensionId, method, params = {}, timeoutMs = 30000) {
    const extension = (await this.store.enabled()).find((item) => item.manifest.id === extensionId)
    if (!extension) return { ok: false, error: '扩展未启用：' + extensionId }
    return this.call(extension.dir, extension.manifest, method, params, timeoutMs)
  }
}

module.exports = { ExtensionHost }
