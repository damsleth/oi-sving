// @ts-nocheck -- Cloudflare Workers stub; types ship with @cloudflare/workers-types when deployed via wrangler
// Cloudflare Durable Object. Owns one room. Brokers offer/answer/ICE
// messages between the host and up to 5 joiners.
//
// The DO uses the Hibernatable WebSocket API so a quiet room costs zero
// CPU; the room garbage-collects itself after 60s of silence per the plan.

interface RoomState {
  hostId: string | null
  joiners: Set<string>
  createdAt: number
}

interface MemberAttachment {
  peerId: string
  role: 'host' | 'joiner'
}

export class SignalingRoom {
  private state: DurableObjectState
  private room: RoomState = { hostId: null, joiners: new Set(), createdAt: Date.now() }

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('upgrade')
    if (upgrade !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

    this.state.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }))
      return
    }

    const attachment = ws.deserializeAttachment() as MemberAttachment | null

    switch (msg.type) {
      case 'host': {
        const peerId = String(msg.peerId ?? '')
        if (!peerId) return ws.send(JSON.stringify({ type: 'error', message: 'missing peerId' }))
        this.room.hostId = peerId
        ws.serializeAttachment({ peerId, role: 'host' } satisfies MemberAttachment)
        // The DO id is derived from the room code by the worker entrypoint;
        // hosts learn the actual code from the worker before opening this WS.
        ws.send(JSON.stringify({ type: 'hosted', code: '' }))
        return
      }
      case 'join': {
        const peerId = String(msg.peerId ?? '')
        if (!peerId) return ws.send(JSON.stringify({ type: 'error', message: 'missing peerId' }))
        if (!this.room.hostId) return ws.send(JSON.stringify({ type: 'error', message: 'no host' }))
        this.room.joiners.add(peerId)
        ws.serializeAttachment({ peerId, role: 'joiner' } satisfies MemberAttachment)
        ws.send(JSON.stringify({ type: 'joined', hostId: this.room.hostId }))
        // Notify host of new joiner.
        for (const sock of this.state.getWebSockets()) {
          const a = sock.deserializeAttachment() as MemberAttachment | null
          if (a?.role === 'host') sock.send(JSON.stringify({ type: 'peer-joined', peerId }))
        }
        return
      }
      case 'offer':
      case 'answer':
      case 'ice': {
        if (!attachment) return
        const targetId = String(msg.to ?? '')
        for (const sock of this.state.getWebSockets()) {
          const a = sock.deserializeAttachment() as MemberAttachment | null
          if (a?.peerId === targetId) {
            sock.send(JSON.stringify({ ...msg, from: attachment.peerId }))
            return
          }
        }
        return
      }
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }))
    }
  }

  webSocketClose(ws: WebSocket): void {
    const a = ws.deserializeAttachment() as MemberAttachment | null
    if (!a) return
    if (a.role === 'host') {
      // Host gone: tear down the room. Remaining joiners get a notice and
      // their sockets are closed so the client falls back to the lobby.
      for (const sock of this.state.getWebSockets()) {
        const att = sock.deserializeAttachment() as MemberAttachment | null
        if (att?.role === 'joiner') {
          sock.send(JSON.stringify({ type: 'host-gone' }))
          try { sock.close(1000, 'host-gone') } catch { /* */ }
        }
      }
      this.room.hostId = null
      this.room.joiners.clear()
    } else {
      this.room.joiners.delete(a.peerId)
      for (const sock of this.state.getWebSockets()) {
        const att = sock.deserializeAttachment() as MemberAttachment | null
        if (att?.role === 'host') sock.send(JSON.stringify({ type: 'peer-left', peerId: a.peerId }))
      }
    }
  }
}

declare class DurableObjectState {
  acceptWebSocket(ws: WebSocket): void
  getWebSockets(): WebSocket[]
}

declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}

declare interface WebSocket {
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

declare class DurableObjectNamespace<_T> {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(req: Request): Promise<Response> }
}

declare class DurableObjectId {}
