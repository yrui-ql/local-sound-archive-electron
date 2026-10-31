const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const DEFAULTS = {
  enabled: true,
  intervalHours: 24,
  backfill: false,
  autoImport: true,
  generateReport: false,
  autoRemoveUnliked: true,
  autoDeleteDuplicates: true,
  autoMaintain: true,
  maintainIntervalHours: 24,
  lastMaintainAt: null,
  nextMaintainAt: null,
  lastRunAt: null,
  nextRunAt: null,
  pendingImport: false,
  updatedAt: null,
}

class LikesStore {
  constructor(root) {
    this.root = root
    this.configPath = path.join(root, 'likes-sync.json')
    this.likesDir = path.join(root, 'likes')
    this.eventsPath = path.join(this.likesDir, 'events.json')
    this.lastRunPath = path.join(this.likesDir, 'last-run.json')
  }

  async ensure() {
    await fsp.mkdir(this.likesDir, { recursive: true })
  }

  async readJson(file, fallback) {
    try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) } catch { return fallback }
  }

  async loadConfig() {
    await this.ensure()
    const saved = await this.readJson(this.configPath, {})
    const cfg = { ...DEFAULTS, ...saved }
    const now = Date.now()
    if (cfg.enabled && !cfg.nextRunAt) cfg.nextRunAt = new Date(now + cfg.intervalHours * 3600000).toISOString()
    if (cfg.autoMaintain && !cfg.nextMaintainAt) cfg.nextMaintainAt = new Date(now + cfg.maintainIntervalHours * 3600000).toISOString()
    return cfg
  }

  async saveConfig(patch) {
    const cfg = await this.loadConfig()
    const allowed = ['enabled', 'intervalHours', 'backfill', 'autoImport', 'generateReport', 'autoRemoveUnliked', 'autoDeleteDuplicates', 'autoMaintain', 'maintainIntervalHours']
    for (const key of allowed) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) cfg[key] = patch[key]
    }
    cfg.intervalHours = Math.max(1, Math.min(720, Number(cfg.intervalHours) || 24))
    cfg.maintainIntervalHours = Math.max(1, Math.min(720, Number(cfg.maintainIntervalHours) || 24))
    if (cfg.enabled) cfg.nextRunAt = new Date(Date.now() + cfg.intervalHours * 3600000).toISOString()
    else cfg.nextRunAt = null
    if (cfg.autoMaintain) cfg.nextMaintainAt = new Date(Date.now() + cfg.maintainIntervalHours * 3600000).toISOString()
    cfg.updatedAt = new Date().toISOString()
    await fsp.writeFile(this.configPath, JSON.stringify(cfg, null, 2))
    return cfg
  }

  async status() {
    const cfg = await this.loadConfig()
    const sources = []
    for (const [id, name] of [['soda', '汽水音乐'], ['netease', '网易云音乐'], ['qq', 'QQ 音乐']]) {
      const state = await this.readJson(path.join(this.likesDir, `state-${id}.json`), {})
      sources.push({
        id,
        name,
        connected: false,
        likedTotal: Number(state.likedTotal) || 0,
        lastSync: state.lastSync || null,
        playlist: state.likedPlaylist?.title || null,
        backfilled: !!state.backfilled,
      })
    }
    return {
      config: cfg,
      cookies: { soda: false, netease: false, qq: false },
      sources,
      events: await this.readJson(this.eventsPath, []),
      lastRun: await this.readJson(this.lastRunPath, null),
      report: null,
    }
  }
}

module.exports = { LikesStore }
