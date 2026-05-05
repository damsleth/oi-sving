# Oi, Sving! signaling

Two deployment options. Both speak the same JSON message protocol over a
single WebSocket so the browser client doesn't care which one is on the
other side.

## 1. Self-host on a Bun runtime

Local dev (no install required):

```sh
bun run server/signaling-node.ts
```

Compile to a standalone executable:

```sh
bun build --compile --outfile=oi-sving-signaling server/signaling-node.ts
./oi-sving-signaling
```

The executable opens `ws://0.0.0.0:8787/` by default. Override with
`PORT=…`. `GET /health` returns a tiny JSON heartbeat for monitoring.

The signaling server is purely a rendezvous: hosts mint a 4-character
room code, joiners exchange it out-of-band, and the server brokers SDP +
ICE between host and joiners. Once datachannels are open, signaling is
no longer on the gameplay data path.

## 2. Cloudflare Workers + Durable Objects

`server/signaling-worker.ts` is the deployable Worker entrypoint.
`server/signaling-room.ts` is a Durable Object that owns one room each
(so SDP offer/answer ordering is racefree per room).

Minimal `wrangler.toml`:

```toml
name = "oi-sving-signaling"
main = "server/signaling-worker.ts"
compatibility_date = "2025-01-01"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "SignalingRoom"

[[migrations]]
tag = "v1"
new_classes = ["SignalingRoom"]
```

```sh
wrangler dev          # local
wrangler deploy       # production
```

After deploy, set:

```js
OiSving.Config.Net.signalingUrl = 'wss://oi-sving-signaling.<your-account>.workers.dev/ws'
```

## Wire protocol

All messages are JSON (the gameplay path uses binary RTC datachannels,
not signaling). The server is connection-agnostic — clients identify
themselves with a `peerId` chosen at connect time.

```jsonc
// Host
> { "type": "host", "peerId": "..." }
< { "type": "hosted", "code": "K7P3" }

// Join
> { "type": "join", "code": "K7P3", "peerId": "..." }
< { "type": "joined", "hostId": "..." }

// Relayed (forwarded between members of the same room)
> { "type": "offer",  "to": "<peerId>", "sdp": "..." }
> { "type": "answer", "to": "<peerId>", "sdp": "..." }
> { "type": "ice",    "to": "<peerId>", "candidate": { ... } }

// Lifecycle
< { "type": "peer-joined", "peerId": "..." }
< { "type": "peer-left",   "peerId": "..." }
< { "type": "host-gone" }
< { "type": "error", "message": "..." }
```

Rooms self-collect after 60s of silence so abandoned codes free up.
