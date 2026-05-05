// @ts-nocheck -- Cloudflare Workers stub; types ship with @cloudflare/workers-types when deployed via wrangler
// Cloudflare Worker entrypoint for the signaling rendezvous. Pairs with
// the SignalingRoom Durable Object so each room's WebSocket fan-out runs
// on a single shard (no cross-DO race for offer/answer ordering).
//
// wrangler.toml stub:
//   [[durable_objects.bindings]]
//   name = "ROOMS"
//   class_name = "SignalingRoom"
//
//   [[migrations]]
//   tag = "v1"
//   new_classes = ["SignalingRoom"]
//
// The worker mints a code, looks up (or creates) the matching DO instance,
// and forwards the upgrade. The DO owns the host/joiner roster and SDP
// relay logic — see ./signaling-room.ts.
//
// This file is a deployable stub: the parity test for it is bringing it up
// under `wrangler dev` and pointing OiSving.Config.Net.signalingUrl at the
// returned wss:// URL.

import type { SignalingRoom } from './signaling-room'

export interface Env {
  ROOMS: DurableObjectNamespace<SignalingRoom>
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function mintCode(): string {
  let code = ''
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    // Clients connect to /ws?code=ABCD (joiners) or /ws (hosts). Hosts get
    // a freshly minted code routed to a brand new DO; joiners are routed
    // by code so they reach the same shard as the host.
    if (url.pathname !== '/ws') {
      return new Response('Not found', { status: 404 })
    }

    let code = url.searchParams.get('code')?.toUpperCase()
    if (!code) {
      // Mint a code; clients still call this with `?role=host` for clarity.
      code = mintCode()
    }
    const id = env.ROOMS.idFromName(code)
    const stub = env.ROOMS.get(id)
    return stub.fetch(request)
  },
}

export { SignalingRoom } from './signaling-room'
