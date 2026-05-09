// LAN game + signaling server for Oi, Sving!. Serves the browser game over
// HTTP and brokers SDP offer/answer + ICE candidates over WebSocket. Runs on
// the Bun runtime (Bun.serve) — no Node.js required.
//
// Run locally:
//   bun run serve
//
// Or compile a standalone executable:
//   bun run build:signaling

import { promises as dns } from 'node:dns'
import { watch as fsWatch } from 'node:fs'

import { embeddedAssets } from './embedded-assets'

const DEV = process.env.OISVING_DEV === '1'

// Dev-only live-reload fanout. Each /__reload subscriber registers its
// stream controller here; the dist/ watcher below pushes one SSE event
// per debounced filesystem change. Empty in production builds.
const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>()

interface RoomMember {
  peerId: string
  ws: ServerWebSocket
  playerIds: string[]
  address: string | null
  hostname: string | null
}

interface Room {
  code: string
  host: RoomMember
  joiners: Map<string, RoomMember>
  createdAt: number
  lastActivityAt: number
}

interface WsData {
  peerId?: string
  code?: string
  address?: string | null
  hostname?: string | null
}

type ServerWebSocket = import('bun').ServerWebSocket<WsData>

const PORT = Number(process.env.PORT ?? 8787)
const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0'
const STATIC_ROOT = process.env.OISVING_STATIC_ROOT ?? process.cwd()
const ROOM_TTL_MS = 60_000
const CODE_LENGTH = 4
// Drop letters that are visually ambiguous on a phone (no I/L/O/0/1).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const rooms = new Map<string, Room>()
const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

function mintCode(): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    }
    if (!rooms.has(code)) return code
  }
  throw new Error('Could not mint a unique room code; the table is suspiciously full.')
}

function send(ws: ServerWebSocket, payload: object): void {
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    // Socket already closed; nothing useful we can do.
  }
}

// Allowed player ids. Anything outside this whitelist would have been a
// canvas-rendering hazard already, but it was also an XSS vector via the
// /rooms list since the menu used innerHTML to render hostPlayerIds. Reject
// here at the edge so neither the WS fanout nor the GET /rooms snapshot
// can carry attacker-controlled strings.
const PLAYER_ID_TABLE = ['red', 'orange', 'green', 'blue', 'purple', 'pink']

function normalizePlayerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set(PLAYER_ID_TABLE)
  return [...new Set(value.map(v => String(v)).filter(id => allowed.has(id)))]
}

function gcRooms(): void {
  const now = Date.now()
  for (const [code, room] of rooms) {
    if (now - room.lastActivityAt <= ROOM_TTL_MS) continue
    // Don't GC a room whose host is still connected. lastActivityAt
    // only tracks signaling messages, which stop flowing once the
    // WebRTC handshake completes — so a long live round looks idle
    // to the room timer. Closing the WebSocket mid-game then makes
    // joiners think the host left. Use the host WS readyState as the
    // real liveness signal: only orphaned/crashed rooms hit this
    // branch.
    if (room.host.ws.readyState === 1) continue // OPEN
    try { room.host.ws.close(1000, 'idle') } catch { /* */ }
    for (const j of room.joiners.values()) {
      try { j.ws.close(1000, 'idle') } catch { /* */ }
    }
    rooms.delete(code)
  }
}

setInterval(gcRooms, 10_000)

function contentType(pathname: string): string {
  const ext = pathname.match(/\.[^.\/]+$/)?.[0]?.toLowerCase()
  return ext ? MIME_TYPES[ext] ?? 'application/octet-stream' : 'application/octet-stream'
}

function staticPath(url: URL): string | null {
  let pathname = '/'
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  // Embedded asset table wins. In a compiled executable this is the only
  // source. In dev these resolve to real fs paths anyway, so the same code
  // serves both modes.
  const embedded = embeddedAssets[pathname]
  if (embedded) return embedded

  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  if (!relative || relative.includes('\0')) return null

  const normalized = relative.split('/').filter(part => part !== '' && part !== '.')
  if (normalized.includes('..')) return null
  return `${STATIC_ROOT}/${normalized.join('/')}`
}

// Reverse DNS is best-effort and runs off the upgrade path. node:dns
// reverse() has no default timeout, so awaiting it inside fetch()
// blocked every WS upgrade behind a slow recursive resolver. We cap
// the lookup at REVERSE_DNS_TIMEOUT_MS and store the result on
// ws.data when (and only if) it lands before the lookup is abandoned.
const REVERSE_DNS_TIMEOUT_MS = 500

function resolveHostnameOffPath(ws: ServerWebSocket): void {
  const address = ws.data.address
  if (!address) return
  let settled = false
  const timer = setTimeout(() => { settled = true }, REVERSE_DNS_TIMEOUT_MS)
  dns.reverse(address).then(names => {
    clearTimeout(timer)
    if (settled) return
    settled = true
    const hostname = names[0] ?? null
    if (hostname) ws.data.hostname = hostname
  }).catch(() => {
    clearTimeout(timer)
    settled = true
  })
}

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: BIND_HOST,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (req.headers.get('upgrade') === 'websocket') {
      // Capture the peer's IP at upgrade time so the host can show
      // who joined even before colors are claimed. Reverse DNS is
      // resolved async in the `open` handler below; ws.data.hostname
      // stays null until (or unless) the lookup lands within the
      // timeout window.
      const ipInfo = srv.requestIP(req)
      const address = ipInfo?.address ?? null
      if (srv.upgrade(req, { data: { address, hostname: null } })) return undefined
      return new Response('websocket upgrade failed\n', { status: 400 })
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, rooms: rooms.size }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname === '/__reload') {
      // Dev-only SSE: the watcher below pushes 'reload' events when
      // dist/ changes. Production / standalone builds 404 here so a
      // shipped binary never speaks the dev protocol.
      if (!DEV) return new Response('Not found\n', { status: 404 })
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          reloadClients.add(controller)
          controller.enqueue(new TextEncoder().encode('retry: 2000\n: connected\n\n'))
        },
        cancel(controller) {
          reloadClients.delete(controller)
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
        },
      })
    }
    if (url.pathname === '/rooms') {
      // LAN discovery: list active rooms with their host's claimed colors
      // and joiner count. Clients poll this to render an "available games"
      // list under the menu. CORS open since the server only ever speaks
      // on the local network — anyone who can reach this endpoint already
      // has a route to the WebSocket.
      const list = [...rooms.values()].map(r => ({
        code: r.code,
        hostPlayerIds: r.host.playerIds,
        joinerCount: r.joiners.size,
      }))
      return new Response(JSON.stringify({ rooms: list }), {
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      })
    }

    const path = staticPath(url)
    if (!path) return new Response('Not found\n', { status: 404 })

    const file = Bun.file(path)
    if (!(await file.exists())) return new Response('Not found\n', { status: 404 })
    return new Response(file, {
      headers: {
        'content-type': contentType(path),
      },
    })
  },
  websocket: {
    open(ws) {
      // Kick off best-effort reverse DNS off the upgrade path. The
      // host/join message handler reads ws.data.hostname at room-
      // member registration time; if DNS hasn't landed yet, hostname
      // stays null and the host UI shows just the address. Acceptable
      // because the feature is cosmetic.
      resolveHostnameOffPath(ws)
    },
    message(ws, raw) {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
      } catch {
        send(ws, { type: 'error', message: 'invalid json' })
        return
      }

      switch (msg.type) {
        case 'host': {
          const peerId = String(msg.peerId ?? '')
          if (!peerId) return send(ws, { type: 'error', message: 'missing peerId' })
          const code = mintCode()
          const room: Room = {
            code,
            host: {
              peerId,
              ws,
              playerIds: normalizePlayerIds(msg.playerIds),
              address: ws.data.address ?? null,
              hostname: ws.data.hostname ?? null,
            },
            joiners: new Map(),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }
          rooms.set(code, room)
          ws.data.peerId = peerId
          ws.data.code = code
          send(ws, { type: 'hosted', code })
          return
        }
        case 'join': {
          const code = String(msg.code ?? '').toUpperCase()
          const peerId = String(msg.peerId ?? '')
          const room = rooms.get(code)
          if (!room) return send(ws, { type: 'error', message: 'unknown room' })
          if (!peerId) return send(ws, { type: 'error', message: 'missing peerId' })
          const playerIds = normalizePlayerIds(msg.playerIds)
          const address = ws.data.address ?? null
          const hostname = ws.data.hostname ?? null
          const existingJoiners = [...room.joiners.values()].map(j => ({
            peerId: j.peerId,
            playerIds: j.playerIds,
            address: j.address,
            hostname: j.hostname,
          }))
          room.joiners.set(peerId, { peerId, ws, playerIds, address, hostname })
          room.lastActivityAt = Date.now()
          ws.data.peerId = peerId
          ws.data.code = code
          send(ws, {
            type: 'joined',
            hostId: room.host.peerId,
            hostPlayerIds: room.host.playerIds,
            peers: existingJoiners,
          })
          send(room.host.ws, { type: 'peer-joined', peerId, playerIds, address, hostname })
          return
        }
        case 'offer':
        case 'answer':
        case 'ice': {
          const code = ws.data.code
          if (!code) return
          const room = rooms.get(code)
          if (!room) return
          room.lastActivityAt = Date.now()
          const targetId = String(msg.to ?? '')
          const fromId = ws.data.peerId ?? ''
          const target = targetId === room.host.peerId
            ? room.host
            : room.joiners.get(targetId)
          if (!target) return
          send(target.ws, { ...msg, from: fromId })
          return
        }
        default:
          send(ws, { type: 'error', message: 'unknown message type' })
      }
    },
    close(ws) {
      const code = ws.data.code
      const peerId = ws.data.peerId
      if (!code) return
      const room = rooms.get(code)
      if (!room) return
      if (room.host.ws === ws) {
        // Host left: notify joiners and drop the room.
        for (const j of room.joiners.values()) {
          send(j.ws, { type: 'host-gone' })
        }
        rooms.delete(code)
      } else if (peerId) {
        room.joiners.delete(peerId)
        send(room.host.ws, { type: 'peer-left', peerId })
      }
    },
  },
})

console.log(`oi-sving LAN server on http://localhost:${server.port}/`)
console.log(`serving ${STATIC_ROOT}`)

if (DEV) {
  // Watch dist/ recursively. Bun rebuilds JS and CSS into dist/, so a
  // single watcher catches both kinds of edits. Debounced because saving
  // a file usually emits 2-3 fs events (truncate + rename + write) and
  // we only want one reload per logical save.
  const distDir = `${STATIC_ROOT}/dist`
  const encoder = new TextEncoder()
  let pending: ReturnType<typeof setTimeout> | null = null
  const fanout = () => {
    pending = null
    const payload = encoder.encode('event: reload\ndata: \n\n')
    for (const ctrl of reloadClients) {
      try { ctrl.enqueue(payload) } catch { reloadClients.delete(ctrl) }
    }
  }
  try {
    fsWatch(distDir, { recursive: true }, () => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(fanout, 120)
    })
    console.log(`[dev] watching ${distDir} for live reload`)
  } catch (e) {
    console.warn(`[dev] could not watch ${distDir}:`, e)
  }
}

// Graceful shutdown so `bun build --compile` outputs exit cleanly under
// SIGTERM (verification step 7 in the multiplayer plan).
const shutdown = () => {
  console.log('shutting down')
  server.stop(true)
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
