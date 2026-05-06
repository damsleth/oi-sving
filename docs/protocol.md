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
| server → joiner | `joined` | `{ hostId, hostPlayerIds[] }` | Server tells the joiner who the host is. |
| server → host | `peer-joined` | `{ peerId, playerIds[] }` | Fired when a joiner connects. |
| server → host | `peer-left` | `{ peerId }` | Fired when a joiner's WS closes. |
| server → joiners | `host-gone` | `{}` | Fired when the host's WS closes. |
| host ↔ joiner via server | `offer`, `answer`, `ice` | `{ from, to, sdp / candidate }` | Server only relays; never inspects. |
| any → server | `error` | `{ message }` | Bad room code, malformed message, etc. |

Server module: `server/signaling-server.ts`. The same Bun process serves the static game and brokers signaling on the same port.

### WebRTC datachannels

Peer ↔ peer, brokered by the signaling channel above. Two channels per connection:

- `control`: `ordered: true`, reliable. Roster, round-start, pause, state-hash.
- `input`: `ordered: false`, `maxRetransmits: 0`. Per-frame input bitfields. Drops are expected; redundancy windows mask them.

Both channels use binary `ArrayBuffer` payloads with a 1-byte type tag at offset 0.

## Message types

| Hex | Name | Channel | Direction | Purpose |
|-----|------|---------|-----------|---------|
| 0x01 | `MSG_START` | control | host → all | Round-start packet: seed, arena, simulation config |
| 0x02 | `MSG_INPUT` | input | any → all | Per-player input bitfield, redundancy window |
| 0x03 | reserved (`MSG_PING`) | — | — | Reserved for future RTT measurement |
| 0x04 | `MSG_LEAVE` | control | any → all | Reserved; peer-left handled via signaling |
| 0x05 | `MSG_STATE_HASH` | control | any → all | Drift-detection gossip every N frames |
| 0x06 | `MSG_PAUSE` | control | host → all | Authoritative pause signal |
| 0x07 | `MSG_UNPAUSE` | control | host → all | Authoritative resume signal |
| 0x08 | `MSG_ROSTER` | control | host → all | Authoritative roster snapshot (JSON) |
| 0x09 | `MSG_CLAIM` | control | joiner → host | Joiner asks the host to claim a player id |
| 0x0a | `MSG_RELEASE` | control | joiner → host | Joiner asks the host to release a player id |

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
```

22 bytes fixed.

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

- Joiner: every entry is written into `InputBuffer.cells`.
- Host: same, but with an ownership check first — the sender peer must own the playerId in the host's authoritative roster, otherwise the packet is dropped silently. Without that check, any peer could overwrite somebody else's input cells.

### MSG_STATE_HASH (0x05)

Sent over control by every peer at `Config.Net.stateHashIntervalFrames` (default 60). Each peer computes a 32-bit FNV-1a hash over canonical arena dims plus `(round(x*100), round(y*100), round(angle*1e6), holeCountDown, 1)` per running curve in stable lexical order.

```
0       u8   MSG_STATE_HASH
1..4    u32  frameId
5..8    u32  hash
```

9 bytes fixed.

Comparison is **frame-aligned**: each peer caches its own hash by frameId in `localHashByFrame`, and on receive compares the remote hash for frame N against the local cached hash for frame N — never against the live current state. Recomputing on receive would diff host-state-at-N against local-state-at-(N+k), which produces false-positive divergence whenever wall clocks differ by more than ~33 ms (always, in practice, due to per-peer `Game.startDelay` drift and network RTT).

If the local peer hasn't reached frame N yet, the remote claim is parked in `pendingRemoteHashes` and resolved when this peer's own gossip for frame N fires.

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

## Determinism guarantees

Lockstep depends on every peer drawing identical RNG sequences in identical order. The protocol enforces this with:

1. **Host-broadcast seed** in MSG_START.
2. **Sorted curve iteration** in `Game.drawFrame` and `Game.initRun` (lexical by playerId).
3. **`resetHoleCountDown` deferred to `initRun`** so the first hole is drawn from the round seed, not the pre-seed RNG state.
4. **Sender-side input redundancy** + **frame-ordered fallback** in `InputBuffer` so out-of-order packet arrival does not change the answer for a missing frame.
5. **Frame-aligned hash compare** so wall-clock skew doesn't show up as drift.

The end-to-end determinism check is `bun run test:e2e:webrtc:long`, which drives both peers' inputs in headless Chrome for ~30 seconds and asserts zero state-hash mismatches.

## When determinism breaks anyway

The drift detection fires `'state-hash-mismatch'`. Current behavior: the event is emitted but no UI surfaces it. The plan calls for aborting the round to lobby on mismatch; that's not yet implemented.

Recovery options not yet implemented:

- Host snapshot resync (host streams a state diff so joiners can re-sync without restarting the round).
- Soft-recovery via host-authoritative state streaming (joiners stop simulating and just render host-supplied state per frame).
