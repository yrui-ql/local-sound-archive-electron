const path = require('node:path')

function cleanTitleText(value) {
  const raw = String(value || '').trim()
  return raw
    .replace(/^\s*\d{1,3}\s*[._\-–—、]\s*/, '')
    .replace(/^\s*\d{1,3}\s+(?=\S)/, '')
    .replace(/^\s*\d{1,3}\s*(?=[《【\[])/, '')
    .trim() || raw
}

function cleanDisplayTitle(file) {
  return cleanTitleText(path.basename(file, path.extname(file)))
}

function safeFileName(value) {
  return String(value || '未命名').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160) || '未命名'
}

function isPathInside(file, roots) {
  const target = path.resolve(String(file || ''))
  return (Array.isArray(roots) ? roots : []).some((root) => {
    const resolved = path.resolve(String(root || ''))
    return target === resolved || target.startsWith(resolved + path.sep)
  })
}

module.exports = { cleanTitleText, cleanDisplayTitle, safeFileName, isPathInside }

