#!/usr/bin/env node
/** Build a self-contained Windows portable folder from the local Electron dist. */
import fs from 'node:fs'
import path from 'node:path'
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
for (const name of ['src', 'ui', 'ai-control', 'extension-sdk', 'scripts']) {
  fs.cpSync(path.join(root, name), path.join(app, name), { recursive: true })
}
fs.copyFileSync(path.join(root, 'package.json'), path.join(app, 'package.json'))
const exe = path.join(out, 'electron.exe')
if (!fs.existsSync(exe)) throw new Error('electron.exe missing')
fs.renameSync(exe, path.join(out, 'LSA.exe'))
console.log('portable build:', path.join(out, 'LSA.exe'))

