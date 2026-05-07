# Wire protocol

How peers talk to each other. Two transports, one signaling channel.

## Transports

### WebSocket signaling

Joiner ↔ server only. JSON over the same WebSocket the server uses for HTTP. The server doesn't see gameplay traffic; it just brokers SDP/ICE between peers and dispatches roster/peer-left fanout messages.

| Direction | `type` | Body | Notes |
|-----------|--------|------|-------|
| host → server | `host` | `{ peerId, playerIds[] }` | Mints a 4-character room code. |
| server → host | `hosted` | `{ code }` | Server replies with the minted code. |
| joiner → server | `join` | `{ code, peerId, playerIds[] }` | Server validates the code. |
| server → joiner | `joined` | `{ hostId, hostPlayerIds[], peers: [{ peerId, playerIds[], address, hostname }] }` | Server tells the joiner who the host is and which existing joiners need direct WebRTC connections. `address` is the peer's IP (string or null); `hostname` is best-effort reverse DNS (often null on LAN). |
| server → host | `peer-joined` | `{ peerId, playerIds[], address, hostname }` | Fired when a joiner connects. `address` and `hostname` populate the host's "who joined" UI. `hostname` may be null if reverse DNS hasn't landed yet (resolved off the upgrade path with a 500ms timeout). |
| server → host | `peer-left` | `{ peerId }` | Fired when a joiner's WS closes. |
| server → joiners | `host-gone` | `{}` | Fired when the host's WS closes. |
| any peer ↔ any peer via server | `offer`, `answer`, `ice` | `{ from, to, sdp / candidate }` | Server only relays; never inspects. New joiners initiate WebRTC connections to the host and all existing joiners from `joined.peers`. |
| any → server | `error` | `{ message }` | Bad room code, malformed message, etc. |

The server assumes a trusted network. There is no per-IP rate limit, no max rooms cap, and no max joiners-per-room cap. The `joined.peers[]` payload includes joiner IPs and hostnames, which is fine for LAN play but makes the room a passive IP-discovery vector if exposed to the public internet.

Server module: `server/signaling-server.ts`. The same Bun process serves the static game and brokers signaling on the same port.

### WebRTC datachannels

Peer ↔ peer, brokered by the signaling channel above. Two channels per connection:

- `control`: `ordered: true`, reliable. Roster, round-start, pause.
- `input`: `ordered: false`, `maxRetransmits: 0`. Per-frame input bitfields and host-authoritative state snapshots. Drops are expected; the next packet supersedes stale state.

Both channels use binary `ArrayBuffer` payloads with a 1-byte type tag at offset 0.

## Message types

| Hex | Name | Channel | Direction | Purpose |
|-----|------|---------|-----------|---------|
| 0x01 | `MSG_START` | control | host → all | Round-start packet: seed, arena, simulation config |
| 0x02 | `MSG_INPUT` | input | any → all | Per-player input bitfield, redundancy window |
| 0x03 | reserved (`MSG_PING`) | — | — | Reserved for future RTT measurement |
| 0x04 | `MSG_LEAVE` | control | any → all | Reserved; peer-left handled via signaling |
| 0x05 | `MSG_STATE_HASH` | control | host → host (diagnostic) | Drift-detection gossip every N frames; joiners drop incoming hashes |
| 0x06 | `MSG_PAUSE` | control | host → all | Authoritative pause signal |
| 0x07 | `MSG_UNPAUSE` | control | host → all | Authoritative resume signal |
| 0x08 | `MSG_ROSTER` | control | host → all | Authoritative roster snapshot (JSON) |
| 0x09 | `MSG_CLAIM` | control | joiner → host | Joiner asks the host to claim a player id |
| 0x0a | `MSG_RELEASE` | control | joiner → host | Joiner asks the host to release a player id |
| 0x0b | `MSG_HOST_STATE` | input | host → all | Authoritative per-frame position/direction/scores snapshot |

### MSG_START (0x01)

Host-authoritative round-start. Sent over control on every round start. Joiners apply the simulation config in this packet to their local `OiSving.Config` before any frame ticks, so a joiner running a slightly different build cannot drift via local config.

```
0       u8   MSG_START
1..4    u32  RNG seed
5..6    u16  arena width  (px in canonical sim space)
7..8    u16  arena height
9..12   u32  start frame id
13      u8   input delay frames
14      u8   state-hash gossip interval (frames)
15      u8   fps
16..17  u16  hole interval (frames between holes)
18..19  u16  hole interval randomness (extra random frames added)
20      u8   initial superpower count
21      u8   allowed-player bitmask (bit 0 = red, 1 = orange, ..., 5 = pink)
22      u8   input redundancy frames (entries per MSG_INPUT packet)
```

23 bytes fixed. Joiners that receive a 22-byte packet from an older host fall back to redundancy=4 — see the length-bound decode in `dispatch`.

### MSG_INPUT (0x02)

Sent over the input channel for one player at a time. Each packet carries the entire redundancy window (last `inputRedundancyFrames` submissions for that player) so a single packet drop is repaired by the next packet — both peers' `InputBuffer.cells` maps converge regardless of arrival order.

```
0       u8   MSG_INPUT
1       u8   playerId index (0..5 → red,orange,green,blue,purple,pink)
2       u8   count (entries that follow)
3..N    per entry: u32 frameId + u8 bits
```

Variable-length: `3 + count * 5` bytes. With the default redundancy of 4, that's 23 bytes per packet.

Bit layout for `bits`:

```
bit 0 = LEFT
bit 1 = RIGHT
bit 2 = SUPERPOWER
```

Receiver side:

- Every peer applies an ownership check before writing into `InputBuffer.cells`.
- The sender peer must own the playerId in the latest roster view, otherwise the packet is dropped silently.
- Known peers with no claimed players are denied. Unknown peers are allowed only for the early WebRTC/roster handshake window, before a roster snapshot has named them. Without the empty-roster denial, a connected-but-unclaimed peer could overwrite somebody else's input cells.

### MSG_STATE_HASH (0x05)

Legacy drift-detection gossip. In current host-authoritative multiplayer, joiners no longer simulate game truth and ignore incoming state hashes. The host still computes a local hash for diagnostics, but authoritative correction is done by `MSG_HOST_STATE`.

```
0       u8   MSG_STATE_HASH
1..4    u32  frameId
5..8    u32  hash
```

9 bytes fixed.

Older lockstep builds compared hashes frame-aligned. That mode is intentionally not the source of truth anymore because timer drift and packet timing can make clients diverge even when input eventually arrives.

### MSG_PAUSE (0x06) / MSG_UNPAUSE (0x07)

```
0       u8   MSG_PAUSE  or  MSG_UNPAUSE
```

1 byte. Host-only. `OiSving.Net.broadcastPause()` and `broadcastUnpause()` skip the local emit so the host's state transitions are still driven by `Game.togglePause`. Joiners listen to the `'pause'` / `'unpause'` events and apply `doPause` / `endPause` locally.

### MSG_ROSTER (0x08)

Host-authoritative roster snapshot. Sent over control on every claim, release, peer-joined, and peer-left. JSON payload after the type byte.

```
0       u8   MSG_ROSTER
1..N    UTF-8 JSON: { hostPeerId, hostPlayerIds[], joiners: [{ peerId, playerIds[] }] }
```

`applyRosterSnapshot` on receive:

- Diffs against the prior local view.
- Emits `'player-joined'` / `'player-left'` for the deltas so menus relock taken colors and unlock released ones.
- Overwrites `localPlayerIds` from the host's truth — if the host rejected our claim, the corresponding `Player.isActive` is force-deactivated.

### MSG_CLAIM (0x09) / MSG_RELEASE (0x0a)

Joiner → host. JSON payload `{ playerId }`. The host validates against its allowed-color list and live roster:

- Color not in `allowedPlayerMask` → reject (rebroadcast roster as-is, joiner reverts).
- Color already taken → reject.
- Otherwise: apply, then `broadcastRoster()` to all peers.

Joiners can also directly call `Net.claimPlayer` and `Net.releasePlayer` from local UI; both go through this same code path.

```
0       u8   MSG_CLAIM  or  MSG_RELEASE
1..N    UTF-8 JSON: { playerId }
```

### MSG_HOST_STATE (0x0b)

Host-authoritative game snapshot. Sent over the unordered input channel after each host simulation frame. Joiners do not advance physics, collision, deaths, or scores locally in network games; they send local input and then apply this host snapshot as truth.

```json
{
  "frameId": 123,
  "isRoundStarted": true,
  "isRunning": true,
  "curves": [
    {
      "playerId": "red",
      "alive": true,
      "x": 100.5,
      "y": 120.25,
      "nextX": 101.7,
      "nextY": 121.1,
      "angle": 0.75,
      "holeCountDown": 42,
      "invisible": false
    }
  ],
  "players": [
    { "playerId": "red", "points": 3, "superpowerCount": 2 }
  ]
}
```

Joiners ignore stale snapshots (`frameId <= lastHostStateFrame`) and ignore `MSG_HOST_STATE` from non-host peers.

`invisible` is set by the host when an Invisibility superpower is active for that curve; absence on the wire reads as `false`. `nextX` / `nextY` are the projected position one tick ahead, used by joiner-side interpolation. `holeCountDown` is the remaining frames until the curve next punches a hole in its trail.

## Determinism guarantees

The host owns game truth. Joiners are prediction/render clients:

1. Joiners send delayed input bitfields.
2. The host runs physics, collision, power-ups, deaths, and scoring.
3. The host sends `MSG_HOST_STATE` every simulation frame.
4. Joiners apply the newest host snapshot and never decide game outcome locally.

The end-to-end multiplayer smoke is `bun run test:e2e:webrtc`, which now exercises a three-peer mesh and verifies joiner-to-joiner input delivery before starting the round.

## When determinism breaks anyway

If host snapshots stop arriving, joiners will visually stall or keep their last authoritative state until the connection fails.

Recovery options not yet implemented:

- Host snapshot resync (host streams a state diff so joiners can re-sync without restarting the round).
- Soft-recovery via host-authoritative state streaming (joiners stop simulating and just render host-supplied state per frame).
