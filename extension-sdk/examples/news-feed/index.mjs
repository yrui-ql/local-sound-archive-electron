import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

const extensionDir = process.env.LSA_EXTENSION_DIR || process.cwd()
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

async function runJob(jobId) {
  const now = new Date().toISOString()
  const record = {
    jobId,
    syncedAt: now,
    items: [],
    note: '示例任务：核心调度器已按时调用扩展 job.run。',
  }
  const output = path.join(extensionDir, 'news-feed.json')
  await fs.writeFile(output, JSON.stringify(record, null, 2), 'utf8')
  return { ok: true, output, items: 0 }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  try {
    if (request.method === 'describe') {
      return send(request.id, {
        name: '新闻同步示例',
        version: '0.1.0',
        capabilities: ['scheduler'],
        jobs: [{ id: 'daily-news', title: '每日新闻同步' }],
      })
    }
    if (request.method === 'health') return send(request.id, { ok: true })
    if (request.method === 'job.run') return send(request.id, await runJob(request.params?.jobId || 'daily-news'))
    send(request.id, { ok: false, error: 'unknown method: ' + request.method })
  } catch (error) {
    send(request.id, { ok: false, error: error.message || String(error) })
  }
})
