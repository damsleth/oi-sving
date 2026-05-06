// Smoke test for the bun-compile single-file signaling executable. Builds
// the binary if it is missing, copies it to a tmpdir outside the repo
// (so embedded-asset resolution is the only source of static files),
// boots it on a sandboxed port, hits the public endpoints, and shuts
// down cleanly.
//
// Run:
//   bun run scripts/smoke-standalone.ts
//
// Exit 0 = pass. Anything else = failure. Stdout reports each step so
// CI logs make sense without crawling stderr.

import { mkdir, rm, copyFile, chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const port = Number(process.env.SMOKE_PORT ?? 8795)
const binaryName = process.platform === 'win32' ? 'oi-sving.exe' : 'oi-sving'
const builtBinaryPath = join(repoRoot, 'dist/server', binaryName)
const sandboxDir = join(tmpdir(), `oi-sving-standalone-smoke-${Date.now()}`)
const sandboxBinary = join(sandboxDir, binaryName)

function log(step: string, msg: string): void {
  console.log(`[smoke-standalone] ${step}: ${msg}`)
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

async function buildIfNeeded(): Promise<void> {
  if (await fileExists(builtBinaryPath)) {
    log('build', `reusing ${builtBinaryPath}`)
    return
  }
  log('build', 'binary missing; running bun run build:standalone')
  const proc = Bun.spawn({
    cmd: ['bun', 'run', 'build:standalone'],
    cwd: repoRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`build:standalone exited ${code}`)
  if (!await fileExists(builtBinaryPath)) {
    throw new Error(`expected ${builtBinaryPath} after build`)
  }
}

async function expect(label: string, fn: () => Promise<boolean>): Promise<void> {
  const ok = await fn().catch(err => { log(label, `threw: ${String(err)}`); return false })
  if (!ok) throw new Error(`assertion failed: ${label}`)
  log(label, 'pass')
}

async function fetchUntil(url: string, predicate: (res: Response) => boolean | Promise<boolean>, timeoutMs: number): Promise<Response> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (await predicate(res)) return res
    } catch (err) {
      lastError = err
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting on ${url}${lastError ? `: ${String(lastError)}` : ''}`)
}

let serverProc: ReturnType<typeof Bun.spawn> | null = null

try {
  await buildIfNeeded()

  await mkdir(sandboxDir, { recursive: true })
  await copyFile(builtBinaryPath, sandboxBinary)
  // The build output is already executable, but copyFile preserves the
  // mode on most platforms — re-assert it just in case.
  if (process.platform !== 'win32') await chmod(sandboxBinary, 0o755)

  log('boot', `starting ${sandboxBinary} on port ${port}`)
  serverProc = Bun.spawn({
    cmd: [sandboxBinary],
    cwd: sandboxDir,
    env: { ...process.env, PORT: String(port), BIND_HOST: '127.0.0.1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const baseUrl = `http://127.0.0.1:${port}`

  await expect('GET /health', async () => {
    const res = await fetchUntil(`${baseUrl}/health`, r => r.ok, 10_000)
    const body = await res.json() as { ok?: boolean }
    return body.ok === true
  })

  await expect('GET /rooms', async () => {
    const res = await fetch(`${baseUrl}/rooms`)
    if (!res.ok) return false
    const body = await res.json() as { rooms?: unknown[] }
    return Array.isArray(body.rooms)
  })

  await expect('GET / serves embedded index.html', async () => {
    const res = await fetch(`${baseUrl}/`)
    if (!res.ok) return false
    const html = await res.text()
    return html.includes('Oi, Sving!') && html.includes('dist/js/oisving.min.js')
  })

  await expect('GET /dist/js/oisving.min.js serves embedded bundle', async () => {
    const res = await fetch(`${baseUrl}/dist/js/oisving.min.js`)
    if (!res.ok) return false
    const text = await res.text()
    return text.length > 1000 && text.includes('OiSving')
  })

  await expect('GET /dist/css/main.css serves embedded css', async () => {
    const res = await fetch(`${baseUrl}/dist/css/main.css`)
    if (!res.ok) return false
    const text = await res.text()
    return text.length > 100
  })

  await expect('GET /dist/images/favicon.ico serves embedded asset', async () => {
    const res = await fetch(`${baseUrl}/dist/images/favicon.ico`)
    return res.ok
  })

  await expect('GET /no-such-path returns 404', async () => {
    const res = await fetch(`${baseUrl}/no-such-path`)
    return res.status === 404
  })

  log('shutdown', 'sending SIGTERM')
  serverProc.kill('SIGTERM')
  // The signaling-server install of SIGTERM exits with 0; tolerate
  // either 0 or 143 (128+15) since some shells report the signal.
  const exitCode = await serverProc.exited
  if (exitCode !== 0 && exitCode !== 143 && exitCode !== null) {
    throw new Error(`server exited ${exitCode} on SIGTERM`)
  }
  log('shutdown', `exit code ${exitCode}`)

  console.log('[smoke-standalone] OK')
} catch (err) {
  console.error(`[smoke-standalone] FAIL: ${String(err)}`)
  if (serverProc) {
    try { serverProc.kill('SIGKILL') } catch { /* */ }
    await serverProc.exited.catch(() => {})
  }
  process.exit(1)
} finally {
  await rm(sandboxDir, { recursive: true, force: true }).catch(() => {})
}
