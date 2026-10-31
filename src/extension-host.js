const path = require('node:path')
const { spawn } = require('node:child_process')

class ExtensionHost {
  constructor(store) {
    this.store = store
  }

  call(dir, manifest, method, params = {}) {
    return new Promise((resolve) => {
      const entry = path.join(dir, manifest.entry || 'index.mjs')
      const child = spawn(process.execPath, [entry], {
        cwd: dir,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
      const timer = setTimeout(() => finish({ ok: false, error: '扩展响应超时' }), 5000)
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
      const response = await this.call(extension.dir, extension.manifest, 'search', { query })
      if (!response.ok) { errors.push(extension.manifest.name + ': ' + response.error); continue }
      const list = response.result?.songs || []
      for (const song of list) songs.push({ ...song, source: song.source || extension.manifest.id })
    }
    return { songs, count: songs.length, errors }
  }
}

module.exports = { ExtensionHost }
