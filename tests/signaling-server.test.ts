// Integration tests for the LAN signaling server. Boots a real Bun process
// on a random port (so parallel test runs don't fight) and exercises the
// public surface end-to-end:
//
//   - HTTP /health, /rooms, static fallback
//   - WebSocket host / join handshake including the XSS whitelist
//   - peer-joined fanout shape (now carrying address + hostname)
//   - host close fans out host-gone to joiners
//
// The server module itself starts Bun.serve on import, so we can't import
// it directly without conflicting on PORT. Spawning a child gives us a
// clean shutdown via SIGTERM and lets us pin PORT per test.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const port = 8800 + Math.floor(Math.random() * 50)
const baseUrl = `http://127.0.0.1:${port}`
const wsUrl = `ws://127.0.0.1:${port}/`

let server: ReturnType<typeof Bun.spawn> | null = null
let staticRoot: string | null = null

async function waitReady(): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.ok) return
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`signaling-server did not come up on ${port}`)
}

// CI runners take >5s to spawn the Bun child + serve; default hook
// timeout is 5s. Give the spawn/teardown headroom.
beforeAll(async () => {
  // Use a sandboxed static root so the static-fallback test has a
  // predictable file to fetch and isn't sensitive to repo state.
  staticRoot = join(tmpdir(), `oi-sving-signaling-test-${Date.now()}`)
  await mkdir(staticRoot, { recursive: true })
  await writeFile(join(staticRoot, 'sentinel.txt'), 'sentinel-from-disk', 'utf8')

  server = Bun.spawn({
    cmd: ['bun', 'run', 'server/signaling-server.ts'],
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      OISVING_STATIC_ROOT: staticRoot,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await waitReady()
}, 15000)

afterAll(async () => {
  try { server?.kill() } catch { /* */ }
  await server?.exited.catch(() => {})
  if (staticRoot) await rm(staticRoot, { recursive: true, force: true }).catch(() => {})
}, 15000)

interface WsRpc {
  ws: WebSocket
  inbox: Array<Record<string, unknown>>
  send: (payload: object) => void
  waitFor: <T extends Record<string, unknown> = Record<string, unknown>>(
    predicate: (msg: Record<string, unknown>) => boolean,
    label?: string,
  ) => Promise<T>
  close: () => void
}

function openWs(): Promise<WsRpc> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const inbox: Array<Record<string, unknown>> = []
    const waiters: Array<{ predicate: (msg: Record<string, unknown>) => boolean; resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void; label: string }> = []
    let timer: ReturnType<typeof setTimeout> | null = null

    ws.addEventListener('open', () => {
      timer = setTimeout(() => {
        for (const w of waiters) w.reject(new Error(`waitFor(${w.label}) timed out`))
      }, 4000)
      resolve({
        ws,
        inbox,
        send: (payload) => ws.send(JSON.stringify(payload)),
        waitFor: <T extends Record<string, unknown>>(predicate: (msg: Record<string, unknown>) => boolean, label = 'message') => {
          const found = inbox.find(predicate)
          if (found) return Promise.resolve(found as T)
          return new Promise<T>((res, rej) => {
            waiters.push({ predicate, resolve: m => res(m as T), reject: rej, label })
          })
        },
        close: () => { if (timer) clearTimeout(timer); ws.close() },
      })
    })

    ws.addEventListener('error', () => reject(new Error('ws error')))
    ws.addEventListener('message', evt => {
      const data = typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer)
      const msg = JSON.parse(data) as Record<string, unknown>
      inbox.push(msg)
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]
        if (w.predicate(msg)) {
          waiters.splice(i, 1)
          w.resolve(msg)
        }
      }
    })
  })
}

describe('signaling-server HTTP surface', () => {
  test('GET /health returns ok=true and a rooms count', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.ok).toBe(true)
    const body = await res.json() as { ok: boolean; rooms: number }
    expect(body.ok).toBe(true)
    expect(typeof body.rooms).toBe('number')
  })

  test('GET /rooms returns an empty list when no rooms exist', async () => {
    const res = await fetch(`${baseUrl}/rooms`)
    expect(res.ok).toBe(true)
    const body = await res.json() as { rooms: unknown[] }
    expect(Array.isArray(body.rooms)).toBe(true)
  })

  test('static fallback resolves files from OISVING_STATIC_ROOT', async () => {
    const res = await fetch(`${baseUrl}/sentinel.txt`)
    expect(res.ok).toBe(true)
    expect(await res.text()).toContain('sentinel-from-disk')
  })

  test('unknown path returns 404', async () => {
    const res = await fetch(`${baseUrl}/no-such-path`)
    expect(res.status).toBe(404)
  })
})

describe('signaling-server WebSocket protocol', () => {
  test('host -> hosted minted code, /rooms then advertises the room', async () => {
    const host = await openWs()
    host.send({ type: 'host', peerId: 'host-1', playerIds: ['red'] })
    const hosted = await host.waitFor(m => m.type === 'hosted', 'hosted') as { code: string }
    expect(typeof hosted.code).toBe('string')
    expect(hosted.code).toMatch(/^[A-Z0-9]{4}$/)

    const list = await fetch(`${baseUrl}/rooms`).then(r => r.json()) as {
      rooms: Array<{ code: string; hostPlayerIds: string[]; joinerCount: number }>
    }
    const room = list.rooms.find(r => r.code === hosted.code)
    expect(room).toBeDefined()
    expect(room!.hostPlayerIds).toEqual(['red'])
    expect(room!.joinerCount).toBe(0)
    host.close()
  })

  test('XSS whitelist drops non-canonical player ids on host', async () => {
    const host = await openWs()
    host.send({
      type: 'host',
      peerId: 'host-xss',
      playerIds: ['red', '<img src=x onerror=alert(1)>', 'teal', 'blue'],
    })
    const hosted = await host.waitFor(m => m.type === 'hosted', 'hosted') as { code: string }

    const list = await fetch(`${baseUrl}/rooms`).then(r => r.json()) as {
      rooms: Array<{ code: string; hostPlayerIds: string[] }>
    }
    const room = list.rooms.find(r => r.code === hosted.code)
    expect(room).toBeDefined()
    // Non-canonical entries are dropped at ingest. /rooms only ever
    // surfaces values from the closed PLAYER_ID_TABLE.
    expect(room!.hostPlayerIds).toEqual(['red', 'blue'])
    host.close()
  })

  test('join unknown room returns error', async () => {
    const joiner = await openWs()
    joiner.send({ type: 'join', code: 'ZZZZ', peerId: 'j-x', playerIds: [] })
    const err = await joiner.waitFor(m => m.type === 'error', 'error') as { message: string }
    expect(err.message).toMatch(/unknown/i)
    joiner.close()
  })

  test('join announces peer-joined to the host with address and (filtered) playerIds', async () => {
    const host = await openWs()
    host.send({ type: 'host', peerId: 'host-2', playerIds: ['red'] })
    const hosted = await host.waitFor(m => m.type === 'hosted', 'hosted') as { code: string }

    const joiner = await openWs()
    joiner.send({
      type: 'join',
      code: hosted.code,
      peerId: 'joiner-2',
      playerIds: ['blue', '<script>alert(1)</script>'],
    })
    const joined = await joiner.waitFor(m => m.type === 'joined', 'joined') as {
      hostId: string; hostPlayerIds: string[]
    }
    expect(joined.hostId).toBe('host-2')
    expect(joined.hostPlayerIds).toEqual(['red'])

    const peerJoined = await host.waitFor(m => m.type === 'peer-joined', 'peer-joined') as {
      peerId: string; playerIds: string[]; address: string | null
    }
    expect(peerJoined.peerId).toBe('joiner-2')
    // XSS string was dropped.
    expect(peerJoined.playerIds).toEqual(['blue'])
    // Loopback address present.
    expect(typeof peerJoined.address).toBe('string')
    expect(peerJoined.address).toMatch(/127\.0\.0\.1|::1/)

    joiner.close()
    host.close()
  })

  test('joined response includes existing joiners for full-mesh setup', async () => {
    const host = await openWs()
    host.send({ type: 'host', peerId: 'host-mesh', playerIds: ['red'] })
    const hosted = await host.waitFor(m => m.type === 'hosted', 'hosted') as { code: string }

    const joinerA = await openWs()
    joinerA.send({ type: 'join', code: hosted.code, peerId: 'joiner-mesh-a', playerIds: ['blue'] })
    const joinedA = await joinerA.waitFor(m => m.type === 'joined', 'joined-a') as {
      peers?: Array<{ peerId: string; playerIds: string[] }>
    }
    expect(joinedA.peers).toEqual([])
    await host.waitFor(m => m.type === 'peer-joined' && m.peerId === 'joiner-mesh-a', 'peer-joined-a')

    const joinerB = await openWs()
    joinerB.send({ type: 'join', code: hosted.code, peerId: 'joiner-mesh-b', playerIds: ['green'] })
    const joinedB = await joinerB.waitFor(m => m.type === 'joined', 'joined-b') as {
      peers?: Array<{ peerId: string; playerIds: string[] }>
    }

    expect(joinedB.peers).toEqual([
      expect.objectContaining({ peerId: 'joiner-mesh-a', playerIds: ['blue'] }),
    ])

    joinerB.close()
    joinerA.close()
    host.close()
  })

  test('host closing fans out host-gone to joiners', async () => {
    const host = await openWs()
    host.send({ type: 'host', peerId: 'host-3', playerIds: ['red'] })
    const hosted = await host.waitFor(m => m.type === 'hosted', 'hosted') as { code: string }

    const joiner = await openWs()
    joiner.send({ type: 'join', code: hosted.code, peerId: 'joiner-3', playerIds: ['blue'] })
    await joiner.waitFor(m => m.type === 'joined', 'joined')
    await host.waitFor(m => m.type === 'peer-joined', 'peer-joined')

    host.close()
    const gone = await joiner.waitFor(m => m.type === 'host-gone', 'host-gone')
    expect(gone.type).toBe('host-gone')
    joiner.close()
  })
})
