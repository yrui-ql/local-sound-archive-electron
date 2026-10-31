const path = require('node:path')

function candidatePaths(agent, options = {}) {
  const platform = options.platform || process.platform
  const pathDirs = Array.isArray(options.pathDirs) ? options.pathDirs : []
  const env = options.env || process.env
  const appRoot = options.appRoot || ''
  const list = []
  if (agent.env && env[agent.env]) list.push(env[agent.env])
  for (const dir of pathDirs) {
    const suffixes = platform === 'win32' ? ['.cmd', '.exe', '.ps1', ''] : ['']
    for (const suffix of suffixes) list.push(path.join(dir, agent.command + suffix))
  }
  if (platform === 'win32' && agent.id === 'cursor') {
    list.push(path.join(env.LOCALAPPDATA || '', 'Programs', 'Cursor', 'Cursor.exe'))
    if (appRoot) list.push(path.join(appRoot, '..', '01_ENV', '20_ai', 'cursor', 'app', 'Cursor.exe'))
  }
  if (platform === 'win32' && agent.id === 'dsh') {
    list.push(path.join(env.LOCALAPPDATA || '', 'Programs', 'DSH', 'DSH.exe'))
    list.push(path.join(env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'))
    list.push(path.join(env.ProgramFiles || '', 'DSH', 'DSH.exe'))
  }
  return list.filter(Boolean)
}

function parseDisplayIcon(output, exeName) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/DisplayIcon\s+REG_\w+\s+(.+)$/i)
    if (!match) continue
    const candidate = match[1].trim().replace(/^"|"$/g, '').replace(/,\d+$/, '')
    if (candidate && path.basename(candidate).toLowerCase() === String(exeName).toLowerCase()) return candidate
  }
  return ''
}

module.exports = { candidatePaths, parseDisplayIcon }
