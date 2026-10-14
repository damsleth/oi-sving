# Oi, Sving! LAN signaling

For local LAN multiplayer, use `server/signaling-server.ts`. It serves the browser
game over HTTP and speaks the JSON signaling protocol over WebSocket on the same
host and port.

## Self-host on a Bun runtime

Local dev (no install required):

```sh
bun run server/signaling-server.ts
```

Open `http://localhost:8787/` on the host machine. Other players on the LAN open
`http://<host-lan-ip>:8787/`.

Compile to a standalone executable:

```sh
bun run build:standalone
./dist/server/oi-sving
```

The executable binds to `0.0.0.0:8787` by default. Override with `BIND_HOST=…`
or `PORT=…`. It serves static files from the current working directory by
default; override with `OISVING_STATIC_ROOT=…`. `GET /health` returns a tiny JSON
heartbeat for monitoring.

The signaling server is purely a rendezvous: hosts mint a 4-character
room code, joiners exchange it out-of-band, and the server brokers SDP +
ICE between host and joiners. Once datachannels are open, signaling is
no longer on the gameplay data path.

## Headless host (`--host`)

```sh
./dist/server/oi-sving --host      # or OISVING_AUTO_HOST=1
```

At startup the server reserves one room code and logs
`auto-host enabled - reserved room code: <CODE>`. The code appears in
`GET /rooms` with `hostPlayerIds: []` and `joinerCount: 0` while vacant.
The first browser to `join` that code is promoted to host and gets
`{ "type": "hosted", "code": "<CODE>", "autoHost": true }` instead of
`joined`; later joiners get the normal `joined` reply with the promoted
peer as `hostId`. When the promoted host disconnects, joiners receive
`host-gone` and the code becomes vacant again for the next joiner. The
server is never a game peer - the host is always a browser.

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
