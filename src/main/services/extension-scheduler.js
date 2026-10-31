const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

class ExtensionScheduler {
  constructor({ host, store, dataDir }) {
    this.host = host
    this.store = store
    this.statePath = path.join(dataDir, 'extension-jobs.json')
    this.state = { jobs: {} }
    this.timer = null
    this.running = new Set()
  }

  async load() {
    try {
      const value = JSON.parse((await fsp.readFile(this.statePath, 'utf8')).replace(/^\uFEFF/, ''))
      if (value && typeof value === 'object' && !Array.isArray(value)) this.state = { jobs: value.jobs || {} }
    } catch { this.state = { jobs: {} } }
  }

  async save() {
    try { await fsp.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf8') } catch { }
  }

  async refresh() {
    const data = await this.store.list()
    for (const extension of data.extensions) {
      if (!extension.enabled) continue
      for (const job of Array.isArray(extension.jobs) ? extension.jobs : []) {
        if (!job || !job.id) continue
        const key = extension.id + '/' + job.id
        if (!this.state.jobs[key]) {
          const hours = Math.max(1, Math.min(720, Number(job.defaultIntervalHours) || 24))
          this.state.jobs[key] = {
            extensionId: extension.id,
            extensionName: extension.name,
            jobId: job.id,
            title: job.title || job.id,
            intervalHours: hours,
            nextRunAt: new Date(Date.now() + hours * 3600000).toISOString(),
            lastRunAt: null,
            lastStatus: 'idle',
            lastError: '',
          }
        }
      }
    }
    await this.save()
  }

  jobs() {
    return Object.values(this.state.jobs).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
  }

  async run(key) {
    const job = this.state.jobs[key]
    if (!job || this.running.has(key)) return { ok: false, error: '任务正在运行或不存在' }
    this.running.add(key)
    try {
      const response = await this.host.invoke(job.extensionId, 'job.run', { jobId: job.jobId }, 15 * 60 * 1000)
      job.lastRunAt = new Date().toISOString()
      job.lastStatus = response.ok ? 'success' : 'error'
      job.lastError = response.ok ? '' : response.error || '未知错误'
      job.nextRunAt = new Date(Date.now() + Math.max(1, job.intervalHours) * 3600000).toISOString()
      await this.save()
      return { ok: response.ok, result: response.result, error: response.error }
    } catch (error) {
      job.lastRunAt = new Date().toISOString()
      job.lastStatus = 'error'
      job.lastError = error.message
      job.nextRunAt = new Date(Date.now() + Math.max(1, job.intervalHours) * 3600000).toISOString()
      await this.save()
      return { ok: false, error: error.message }
    } finally {
      this.running.delete(key)
    }
  }

  async tick() {
    await this.refresh()
    const now = Date.now()
    for (const [key, job] of Object.entries(this.state.jobs)) {
      if (Date.parse(job.nextRunAt) <= now) await this.run(key)
    }
  }

  async start() {
    await this.load()
    await this.refresh()
    this.timer = setInterval(() => { this.tick().catch(() => { }) }, 60 * 1000)
    this.timer.unref?.()
    this.tick().catch(() => { })
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

module.exports = { ExtensionScheduler }
