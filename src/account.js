const fs = require('node:fs')
const path = require('node:path')
const QRCode = require('qrcode')
const { DatabaseSync } = require('node:sqlite')

class AccountService {
  constructor(root, baseUrl) {
    this.root = root
    this.baseUrl = baseUrl
    this.cookie = ''
  }

  readCredentials() {
    const candidates = [
      process.env.LSA_ADMIN_CREDENTIALS,
      path.join(this.root, 'admin-credentials.txt'),
      path.resolve(this.root, '..', '..', '03_DATA', '50_music', 'admin-credentials.txt'),
      path.resolve(this.root, '..', '..', '..', '03_DATA', '50_music', 'admin-credentials.txt'),
    ].filter(Boolean)
    for (const file of candidates) {
      try {
        const text = fs.readFileSync(file, 'utf8')
        const username = (text.match(/^username=(.+)$/m) || [])[1]?.trim()
        const password = (text.match(/^password=(.+)$/m) || [])[1]?.trim()
        if (username && password) return { username, password }
      } catch { }
    }
    return null
  }

  async ensureAdmin() {
    if (this.cookie) return true
    const credentials = this.readCredentials()
    if (!credentials) return false
    try {
      const response = await fetch(this.baseUrl + '/music/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ next: '/music', username: credentials.username, password: credentials.password }),
      })
      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')]
      this.cookie = setCookies.filter(Boolean).map((value) => value.split(';')[0]).join('; ')
      return !!this.cookie
    } catch {
      return false
    }
  }

  readSodaCookie() {
    const candidates = [
      process.env.SODA_COOKIE_DB,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'SodaMusic', 'Network', 'Cookies') : '',
      process.env.HOME ? path.join(process.env.HOME, 'Library', 'Application Support', 'SodaMusic', 'Network', 'Cookies') : '',
    ].filter(Boolean)
    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue
        const db = new DatabaseSync(file, { readOnly: true })
        const rows = db.prepare("SELECT name, value FROM cookies WHERE host_key LIKE '%qishui.com' AND length(value) > 0").all()
        db.close()
        const seen = new Set()
        const parts = []
        for (const row of rows) {
          if (!row.value || seen.has(row.name)) continue
          seen.add(row.name)
          parts.push(row.name + '=' + row.value)
        }
        if (parts.length >= 8) return parts.join('; ')
      } catch { }
    }
    return ''
  }

  async refreshSoda() {
    if (!(await this.ensureAdmin())) return false
    const cookie = this.readSodaCookie()
    if (!cookie) return false
    try {
      const response = await fetch(this.baseUrl + '/music/cookies', {
        method: 'POST',
        headers: { Cookie: this.cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ soda: cookie }),
      })
      return response.ok
    } catch { return false }
  }

  async cookieStatus() {
    const result = { soda: false, netease: false, qq: false }
    if (!(await this.ensureAdmin())) return result
    try {
      const { data } = await this.request('/music/cookies')
      for (const source of Object.keys(result)) {
        result[source] = typeof data[source] === 'string' && data[source].trim().length > 0
      }
    } catch { }
    return result
  }

  async request(pathname, options = {}) {
    const response = await fetch(this.baseUrl + pathname, {
      ...options,
      headers: { Cookie: this.cookie, 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) },
    })
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = {} }
    return { response, data, text }
  }

  async qrStart(source) {
    if (!['netease', 'qq'].includes(source)) return { ok: false, error: '该平台暂不支持客户端内扫码登录' }
    if (!(await this.ensureAdmin())) return { ok: false, error: '本机下载服务未登录，无法创建二维码' }
    try {
      const { response, data, text } = await this.request('/music/qr_login/' + source, { method: 'POST' })
      if (!response.ok) return { ok: false, error: `创建二维码失败（HTTP ${response.status}）` }
      let key = data.key || ''
      let image = data.image_url || ''
      if (!image && data.url) image = await QRCode.toDataURL(data.url, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
      if (!image) return { ok: false, error: '二维码图片生成失败' }
      return { ok: true, source, key, image, status: 'waiting', message: source === 'qq' ? '请打开 QQ 音乐扫码' : '请打开网易云音乐扫码' }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  async qrPoll(source, key) {
    if (!['netease', 'qq'].includes(source) || !key) return { ok: false, error: '二维码会话无效' }
    if (!(await this.ensureAdmin())) return { ok: false, error: '本机下载服务未登录' }
    try {
      const { response, data } = await this.request('/music/qr_login/' + source + '?key=' + encodeURIComponent(key))
      if (!response.ok) return { ok: false, error: `检查登录状态失败（HTTP ${response.status}）` }
      const status = data.status || 'waiting'
      if (status !== 'success') return { ok: true, status, message: data.message || '' }
      const cookie = data.cookie || (data.cookies && JSON.stringify(data.cookies)) || ''
      if (!cookie) return { ok: false, error: '登录成功但没有拿到 Cookie' }
      const save = await fetch(this.baseUrl + '/music/cookies', {
        method: 'POST',
        headers: { Cookie: this.cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ [source]: typeof cookie === 'string' ? cookie : JSON.stringify(cookie) }),
      })
      if (!save.ok) return { ok: false, error: '登录成功但保存 Cookie 失败' }
      return { ok: true, status: 'success', message: '登录成功，已保存本机 Cookie' }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }
}

module.exports = { AccountService }



