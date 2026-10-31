const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

class ExtensionStore {
  constructor(root, sampleDir) {
    this.root = root
    this.sampleDir = sampleDir
    this.statePath = path.join(root, 'extensions.json')
  }

  async ensure() {
    await fsp.mkdir(this.root, { recursive: true })
    if (!fs.existsSync(this.statePath)) await fsp.writeFile(this.statePath, JSON.stringify({ safeMode: false, disabled: [] }, null, 2))
  }

  async state() {
    await this.ensure()
    try { return JSON.parse((await fsp.readFile(this.statePath, 'utf8')).replace(/^\uFEFF/, '')) } catch { return { safeMode: false, disabled: [] } }
  }

  async save(state) {
    await fsp.writeFile(this.statePath, JSON.stringify(state, null, 2))
  }

﻿  async list() {
    const state = await this.state()
    const extensions = []
    await fsp.mkdir(this.root, { recursive: true })
    for (const entry of await fsp.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.root, entry.name)
      let manifest = {}
      try { manifest = JSON.parse((await fsp.readFile(path.join(dir, 'extension.json'), 'utf8')).replace(/^\uFEFF/, '')) } catch { }
      if (!manifest.id) continue
      extensions.push({
        id: manifest.id,
        name: manifest.name || manifest.id,
        version: manifest.version || '0.0.0',
        activeVersion: manifest.version || '0.0.0',
        enabled: !state.disabled.includes(manifest.id),
        kind: manifest.kind || 'source',
        description: manifest.description || '',
        permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
        capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
        sources: Array.isArray(manifest.sources) ? manifest.sources : [],
        jobs: Array.isArray(manifest.jobs) ? manifest.jobs : [],
        canRollback: false,
        lastGood: null,
      })
    }
    return { extensions, safeMode: !!state.safeMode }
  }

  async enabled() {
    const state = await this.state()
    const out = []
    if (state.safeMode) return out
    await fsp.mkdir(this.root, { recursive: true })
    for (const entry of await fsp.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(this.root, entry.name)
      let manifest = {}
      try { manifest = JSON.parse((await fsp.readFile(path.join(dir, 'extension.json'), 'utf8')).replace(/^\uFEFF/, '')) } catch { }
      if (!manifest.id || state.disabled.includes(manifest.id)) continue
      out.push({ dir, manifest })
    }
    return out
  }
  async install(sourceDir) {
    const manifestPath = path.join(sourceDir, 'extension.json')
    if (!fs.existsSync(manifestPath)) throw new Error('缺少 extension.json')
    const manifest = JSON.parse((await fsp.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''))
    if (!manifest.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id)) throw new Error('扩展 id 无效')
    const target = path.join(this.root, manifest.id)
    await fsp.rm(target, { recursive: true, force: true })
    await fsp.cp(sourceDir, target, { recursive: true })
    const state = await this.state()
    state.disabled = state.disabled.filter((id) => id !== manifest.id)
    await this.save(state)
    return { ok: true, id: manifest.id }
  }

  async installSample() {
    if (!fs.existsSync(path.join(this.sampleDir, 'extension.json'))) throw new Error('示例扩展不存在')
    return this.install(this.sampleDir)
  }

  async action(id, action) {
    const state = await this.state()
    if (!id) return { ok: false, error: '缺少扩展 id' }
    if (action === 'remove') {
      await fsp.rm(path.join(this.root, id), { recursive: true, force: true })
      state.disabled = state.disabled.filter((x) => x !== id)
      await this.save(state)
      return { ok: true }
    }
    if (action === 'enable') state.disabled = state.disabled.filter((x) => x !== id)
    else if (action === 'disable') {
      if (!state.disabled.includes(id)) state.disabled.push(id)
    } else return { ok: false, error: '不支持的扩展操作' }
    await this.save(state)
    return { ok: true }
  }

  async setSafeMode(safeMode) {
    const state = await this.state()
    state.safeMode = !!safeMode
    await this.save(state)
    return { ok: true, safeMode: state.safeMode }
  }
}

module.exports = { ExtensionStore }

