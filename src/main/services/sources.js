const BUILTIN_SOURCES = [
  { id: 'netease', name: '网易云音乐', kind: 'builtin', auth: ['qr'], likes: true },
  { id: 'qq', name: 'QQ 音乐', kind: 'builtin', auth: ['qr'], likes: true },
  { id: 'soda', name: '汽水音乐', kind: 'builtin', auth: ['cookie'], likes: true },
]

function buildSourceRegistry(extensions = []) {
  const registered = []
  for (const extension of extensions) {
    if (!extension || extension.enabled === false) continue
    for (const source of Array.isArray(extension.sources) ? extension.sources : []) {
      if (!source || !source.id) continue
      const auth = Array.isArray(source.auth) ? source.auth : source.auth ? [source.auth] : []
      registered.push({
        id: source.id,
        name: source.name || extension.name || source.id,
        kind: 'extension',
        extensionId: extension.id,
        auth,
        likes: !!source.likes,
      })
    }
  }
  return [...BUILTIN_SOURCES, ...registered]
}

module.exports = { BUILTIN_SOURCES, buildSourceRegistry }
