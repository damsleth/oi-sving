// Dev-only auto-reload: /__reload returns 404 unless the server is
// started with OISVING_DEV=1, and when it IS dev, dist/ filesystem
// changes fan out as SSE 'reload' events. Production builds must
// never speak this protocol; the standalone executable inherits the
// no-DEV behavior so a shipped binary can't accidentally reload.
//
// Spawns two server children (one DEV, one not) on distinct ports so
// the matrix can be verified end-to-end without flag-flipping a single
// instance.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

interface ServerHandle {
  proc: ReturnType<typeof Bun.spawn>
  port: number
  staticRoot: string
}

async function startServer(opts: { dev: boolean }): Promise<ServerHandle> {
  const port = 8900 + Math.floor(Math.random() * 90)
  const staticRoot = await mkdtemp(join(tmpdir(), 'oi-sving-dev-reload-'))
  // Seed dist/ so the watcher has something to watch.
  await mkdir(join(staticRoot, 'dist', 'js'), { recursive: true })
  await writeFile(join(staticRoot, 'dist', 'js', 'oisving.min.js'), 'console.log(\"v0\")', 'utf8')

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    OISVING_STATIC_ROOT: staticRoot,
  }
  if (opts.dev) env.OISVING_DEV = '1'
  else delete env.OISVING_DEV

  const proc = Bun.spawn({
    cmd: ['bun', 'run', 'server/signaling-server.ts'],
    cwd: repoRoot,
    env,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  // Wait until /health responds.
  const started = Date.now()
  while (Date.now() - started < 10000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return { proc, port, staticRoot }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 100))
  }
  try { proc.kill() } catch { /* */ }
  throw new Error(`server did not come up on ${port}`)
}

async function stopServer(h: ServerHandle): Promise<void> {
  try { h.proc.kill() } catch { /* */ }
  await h.proc.exited.catch(() => {})
  await rm(h.staticRoot, { recursive: true, force: true }).catch(() => {})
}

describe('dev-reload SSE', () => {
  let prod: ServerHandle | null = null
  let dev: ServerHandle | null = null

  beforeAll(async () => {
    prod = await startServer({ dev: false })
    dev = await startServer({ dev: true })
  }, 30000)

  afterAll(async () => {
    if (prod) await stopServer(prod)
    if (dev) await stopServer(dev)
  }, 15000)

  test('/__reload returns 404 when OISVING_DEV is unset', async () => {
    if (!prod) throw new Error('prod not started')
    const res = await fetch(`http://127.0.0.1:${prod.port}/__reload`)
    expect(res.status).toBe(404)
    await res.body?.cancel().catch(() => {})
  })

  test('/__reload returns SSE headers under OISVING_DEV=1', async () => {
    if (!dev) throw new Error('dev not started')
    const res = await fetch(`http://127.0.0.1:${dev.port}/__reload`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toContain('no-cache')
    await res.body?.cancel().catch(() => {})
  })

  test('a write under dist/ triggers a "reload" SSE event', async () => {
    if (!dev) throw new Error('dev not started')

    const ctrl = new AbortController()
    const res = await fetch(`http://127.0.0.1:${dev.port}/__reload`, { signal: ctrl.signal })
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const readUntilReload = (async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return false
        buffer += decoder.decode(value, { stream: true })
        if (buffer.includes('event: reload')) return true
      }
    })()

    // Give the SSE handshake a moment, then mutate dist/.
    await new Promise(r => setTimeout(r, 200))
    await writeFile(join(dev.staticRoot, 'dist', 'js', 'oisving.min.js'), `console.log(\"v${Date.now()}\")`, 'utf8')

    const got = await Promise.race([
      readUntilReload,
      new Promise<boolean>(r => setTimeout(() => r(false), 3000)),
    ])
    expect(got).toBe(true)

    ctrl.abort()
    await reader.cancel().catch(() => {})
  }, 10000)
})
