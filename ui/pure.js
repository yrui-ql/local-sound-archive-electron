(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.LSAPure = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clampUiScale(value, min = 0.85, max = 1.5) {
    let scale = Number(value)
    if (!Number.isFinite(scale)) scale = 1
    scale = Math.max(min, Math.min(max, scale))
    return Math.round(scale * 100) / 100
  }

  function filterSearchEntries(songs, sourceId) {
    const list = Array.isArray(songs) ? songs : []
    return list
      .map((song, index) => ({ song, index }))
      .filter(({ song }) => sourceId === 'all' || song.source === sourceId)
  }

  function pushHistory(history, track, max = 200) {
    const list = Array.isArray(history) ? history.slice() : []
    if (!track || !track.url) return list
    const last = list[list.length - 1]
    if (last && last.url === track.url) return list
    list.push(track)
    while (list.length > max) list.shift()
    return list
  }

  function popHistory(history, currentUrl) {
    const list = Array.isArray(history) ? history.slice() : []
    let previous = null
    while (list.length) {
      const candidate = list.pop()
      if (!currentUrl || candidate.url !== currentUrl) {
        previous = candidate
        break
      }
    }
    return { previous, history: list }
  }

  function recentByteLength(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
    return text.length * 2
  }

  function pruneRecent(items, options = {}) {
    const maxItems = Math.max(1, Math.min(500, Number(options.maxItems) || 60))
    const maxAgeDays = Math.max(1, Math.min(3650, Number(options.maxAgeDays) || 30))
    const maxBytes = Math.max(1024, Math.min(20 * 1024 * 1024, Number(options.maxBytes) || 512 * 1024))
    const now = Number(options.now) || Date.now()
    const cutoff = now - maxAgeDays * 86400000
    const seen = new Set()
    const result = []
    let bytes = 0
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.url || seen.has(item.url)) continue
      const at = Date.parse(item.at || '')
      if (Number.isFinite(at) && at < cutoff) continue
      const size = recentByteLength(item)
      if (result.length && bytes + size > maxBytes) break
      seen.add(item.url)
      result.push(item)
      bytes += size
      if (result.length >= maxItems) break
    }
    return result
  }

  function smoothSeekTime(display, target, elapsed = 0, playbackRate = 1) {
    let next = Number(display) || 0
    if (!Number.isFinite(Number(target))) return next
    const actual = Number(target)
    if (elapsed > 0) next += Math.min(0.1, elapsed) * (Number(playbackRate) || 1)
    const drift = actual - next
    if (Math.abs(drift) > 2) next = actual
    else next += drift * 0.2
    return next
  }

  return { clampUiScale, filterSearchEntries, pushHistory, popHistory, smoothSeekTime, pruneRecent }
})


