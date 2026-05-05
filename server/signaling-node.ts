// Self-hostable WebSocket signaling rendezvous for Oi, Sving!. Brokers
// SDP offer/answer + ICE candidates between a host and up to 5 joiners,
// then drops out of the data path once datachannels are open.
//
// Run locally:
//   bun run server/signaling-node.ts
//
// Or compile a standalone executable:
//   bun build --compile --outfile=oi-sving-signaling server/signaling-node.ts
//
// Configure the client to point at this server by setting
// `OiSving.Config.Net.signalingUrl` to e.g. `ws://localhost:8787/`.

interface RoomMember {
  peerId: string
  ws: ServerWebSocket
}

interface Room {
  code: string
  host: RoomMember
  joiners: Map<string, RoomMember>
  createdAt: number
  lastActivityAt: number
}

type ServerWebSocket = import('bun').ServerWebSocket<{ peerId?: string; code?: string }>

const PORT = Number(process.env.PORT ?? 8787)
const ROOM_TTL_MS = 60_000
const CODE_LENGTH = 4
// Drop letters that are visually ambiguous on a phone (no I/L/O/0/1).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const rooms = new Map<string, Room>()

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

function gcRooms(): void {
  const now = Date.now()
  for (const [code, room] of rooms) {
    if (now - room.lastActivityAt > ROOM_TTL_MS) {
      try { room.host.ws.close(1000, 'idle') } catch { /* */ }
      for (const j of room.joiners.values()) {
        try { j.ws.close(1000, 'idle') } catch { /* */ }
      }
      rooms.delete(code)
    }
  }
}

setInterval(gcRooms, 10_000)

const server = Bun.serve<{ peerId?: string; code?: string }>({
  port: PORT,
  fetch(req, srv) {
    if (srv.upgrade(req, { data: {} })) return undefined
    if (new URL(req.url).pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, rooms: rooms.size }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('oi-sving signaling. WebSocket only.\n', { status: 426 })
  },
  websocket: {
    open(_ws) {
      // No-op until the client identifies itself with a host/join message.
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
            host: { peerId, ws },
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
          room.joiners.set(peerId, { peerId, ws })
          room.lastActivityAt = Date.now()
          ws.data.peerId = peerId
          ws.data.code = code
          send(ws, { type: 'joined', hostId: room.host.peerId })
          send(room.host.ws, { type: 'peer-joined', peerId })
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

console.log(`oi-sving signaling on ws://localhost:${server.port}/`)

// Graceful shutdown so `bun build --compile` outputs exit cleanly under
// SIGTERM (verification step 7 in the multiplayer plan).
const shutdown = () => {
  console.log('shutting down')
  server.stop(true)
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
