const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

class ProvenanceStore {
  constructor(file) {
    this.file = file
    this.items = {}
    this.loaded = false
  }

  async load() {
    if (this.loaded) return this.items
    try {
      const raw = JSON.parse((await fsp.readFile(this.file, 'utf8')).replace(/^\uFEFF/, ''))
      this.items = raw && typeof raw.items === 'object' ? raw.items : {}
    } catch {
      this.items = {}
    }
    this.loaded = true
    return this.items
  }

  key(file) {
    return path.resolve(String(file || ''))
  }

  lookup(file) {
    const item = this.items[this.key(file)]
    return item ? String(item.source || '') : ''
  }

  async record(file, entry = {}) {
    await this.load()
    if (!file) return null
    const key = this.key(file)
    const previous = this.items[key] || {}
    this.items[key] = {
      source: String(entry.source || previous.source || ''),
      title: String(entry.title || previous.title || ''),
      artist: String(entry.artist || previous.artist || ''),
      at: entry.at || previous.at || new Date().toISOString(),
    }
    await this.save()
    return this.items[key]
  }

  async ingestRecords(records) {
    await this.load()
    let count = 0
    for (const record of Array.isArray(records) ? records : []) {
      const file = record?.Path || record?.SavePath || record?.FilePath || record?.path || ''
      if (!file || !fs.existsSync(file)) continue
      await this.record(file, {
        source: record.Source || record.source || '',
        title: record.Name || record.name || '',
        artist: record.Artist || record.artist || '',
      })
      count++
    }
    return count
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    const temp = this.file + '.tmp'
    await fsp.writeFile(temp, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8')
    await fsp.rename(temp, this.file)
  }
}

module.exports = { ProvenanceStore }
