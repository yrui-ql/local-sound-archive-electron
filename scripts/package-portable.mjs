#!/usr/bin/env node
/** Build a self-contained Windows portable folder from the local Electron dist. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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
for (const name of ['qrcode', 'dijkstrajs', 'pngjs']) {
  const source = path.join(root, 'node_modules', name)
  if (fs.existsSync(source)) fs.cpSync(source, path.join(appModules, name), { recursive: true })
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

// Electron ships a few upstream test constants (a fixture path and fake AWS
// examples). They are not user data, but the release privacy gate treats any
// literal path/key in a binary as a finding, so redact those constants.
function redactVendorNoise(file) {
  const buffer = fs.readFileSync(file)
  const text = buffer.toString('latin1')
  const patterns = [
    /C:\\abc\\def/g,
    /AKIA[0-9A-Z]{16}/gi,
    /gh[pousr]_[A-Za-z0-9]{20,}/g,
    /sk-[A-Za-z0-9]{20,}/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text))) {
      buffer.fill(0, match.index, match.index + match[0].length)
    }
  }
  fs.writeFileSync(file, buffer)
}
// redactVendorNoise(electronExe) // upstream Electron test constants; keep runtime intact
console.log('portable build:', targetExe)






