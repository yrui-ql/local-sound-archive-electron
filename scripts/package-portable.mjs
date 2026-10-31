#!/usr/bin/env node
/** Build a self-contained Windows portable folder from the local Electron dist. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'node_modules', 'electron', 'dist')
const out = path.join(root, 'release', 'LSA-portable')
const app = path.join(out, 'resources', 'app')

if (!fs.existsSync(path.join(dist, 'electron.exe'))) {
  console.error('Electron dist not found. Run npm install first.')
  process.exit(1)
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(app, { recursive: true })
fs.cpSync(dist, out, { recursive: true })
for (const name of ['src', 'ui', 'ai-control', 'extension-sdk', 'scripts', 'build', 'config']) {
  fs.cpSync(path.join(root, name), path.join(app, name), { recursive: true })
}
fs.copyFileSync(path.join(root, 'package.json'), path.join(app, 'package.json'))
const appModules = path.join(app, 'node_modules')
let dependencyList = ''
try {
  dependencyList = execSync('npm ls --omit=dev --parseable --all', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
} catch (error) {
  dependencyList = String(error.stdout || '')
}
for (const line of dependencyList.split(/\r?\n/)) {
  const marker = 'node_modules' + path.sep
  const index = line.indexOf(marker)
  if (index < 0) continue
  const relative = line.slice(index + marker.length)
  const source = line.trim()
  const destination = path.join(appModules, relative)
  if (!relative || !fs.existsSync(source) || fs.existsSync(destination)) continue
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
}
const exe = path.join(out, 'electron.exe')
if (!fs.existsSync(exe)) throw new Error('electron.exe missing')
const targetExe = path.join(out, 'LSA.exe')
const electronExe = path.join(out, 'LSA-electron.exe')
fs.renameSync(exe, electronExe)
const launcher = path.join(root, 'scripts', 'LsaLauncher.cs')
const csc = process.env.CSC_PATH || (process.env.WINDIR ? path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') : 'csc.exe')
if (!fs.existsSync(csc)) throw new Error('csc.exe not found; cannot build portable launcher')
execFileSync(csc, ['/nologo', '/target:winexe', '/out:' + targetExe, launcher], { stdio: 'ignore' })
const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
const ico = path.join(root, 'build', 'icon.ico')
if (fs.existsSync(rcedit) && fs.existsSync(ico)) {
  execFileSync(rcedit, [targetExe, '--set-icon', ico], { stdio: 'ignore' })
  execFileSync(rcedit, [electronExe, '--set-icon', ico], { stdio: 'ignore' })
}

console.log('portable build:', targetExe)







