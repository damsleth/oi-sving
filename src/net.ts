// Lockstep multiplayer transport. Pairs a tiny WebSocket signaling client
// with a full mesh of WebRTC peer connections. Each peer simulates the
// whole game locally; only per-frame input bitfields cross the wire.
//
// Channels per peer connection:
//   - control: reliable + ordered. Roster, START, LEAVE, STATE_HASH gossip.
//   - input:   unordered, maxRetransmits=0. Per-frame input snapshots,
//              redundantly retransmitted so single packet drops do not
//              stall the lockstep tick gate.
//
// Public API consumed by Game/Menu/Curve:
//   host()                       — register with signaling, mint a code
//   join(code)                   — connect to host via signaling
//   startRound(seed, arena)      — host: broadcast round-start packet
//   sendLocalInputs(frame, bits) — submit local bitfield for transmission
//   getInputsForFrame(frame, id) — read deterministic input for any player
//   on(event, fn)                — subscribe to roster/start/leave events
//
// The hard timing requirement is that input destined for `frameId` is
// transmitted as soon as it is sampled but only takes effect at
// `frameId + INPUT_DELAY_FRAMES`. Same delay applied to local AND remote
// players preserves "feel" — own input never feels snappier than remote.
//
// Determinism strategy: Mulberry32 seed from host, canonical arena from
// host, fixed simulation tick order, no Math.random anywhere in the
// simulation path. State-hash gossip every 60 frames detects drift early.

import { OiSving } from './namespace'
import { Rng, setSimRng } from './rng'
import {
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_SUPERPOWER,
  type InputBits,
  type InputProvider,
  setInputProvider,
} from './input-provider'

const MSG_START = 0x01
const MSG_INPUT = 0x02
// MSG_PING reserved (0x03)
const MSG_LEAVE = 0x04
const MSG_STATE_HASH = 0x05
const MSG_PAUSE = 0x06
const MSG_UNPAUSE = 0x07
// Roster sync. Host is authoritative for which colors are claimed by which
// peer. Joiners send MSG_CLAIM/MSG_RELEASE; the host validates against its
// authoritative state and rebroadcasts MSG_ROSTER to every peer. Peers
// reconcile their local menus from the broadcast — i.e. the host's reply
// is the ground truth, joiner-side optimistic updates are corrected.
const MSG_ROSTER = 0x08
const MSG_CLAIM = 0x09
const MSG_RELEASE = 0x0a

export interface RosterEntry {
  peerId: string
  playerId: string
  isLocal: boolean
}

export interface NetEvents {
  'player-joined': (entry: RosterEntry) => void
  'player-left': (entry: RosterEntry) => void
  'round-start': (seed: number, arenaWidth: number, arenaHeight: number, startFrame: number) => void
  'state-hash-mismatch': (frameId: number, expected: number, actual: number) => void
  'pause': () => void
  'unpause': () => void
  'roster-update': (snapshot: RosterSnapshot) => void
  'connection-state': (state: 'idle' | 'signaling' | 'connecting' | 'open' | 'closed') => void
}

// Authoritative roster broadcast by the host on every claim/release/leave.
// Joiners overwrite their local view with this; menus and lock states are
// rebuilt from it.
export interface RosterSnapshot {
  hostPeerId: string
  hostPlayerIds: string[]
  joiners: Array<{ peerId: string; playerIds: string[] }>
}

type EventName = keyof NetEvents

class EventBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<EventName, Set<(...args: any[]) => void>>()
  on<E extends EventName>(name: E, fn: NetEvents[E]): () => void {
    let set = this.handlers.get(name)
    if (!set) {
      set = new Set()
      this.handlers.set(name, set)
    }
    set.add(fn as (...args: unknown[]) => void)
    return () => set!.delete(fn as (...args: unknown[]) => void)
  }
  emit<E extends EventName>(name: E, ...args: Parameters<NetEvents[E]>): void {
    const set = this.handlers.get(name)
    if (!set) return
    for (const fn of set) (fn as (...args: unknown[]) => void)(...args)
  }
}

interface PeerSlot {
  peerId: string
  pc: RTCPeerConnection
  control: RTCDataChannel | null
  input: RTCDataChannel | null
  playerId: string
  outboundQueue: Array<{ channel: 'control' | 'input'; msg: ArrayBuffer }>
}

// Buffered per-(frame, playerId) input bitfield. The input channel is
// unordered + maxRetransmits=0, so a single dropped packet is normal.
// Each transmitted INPUT message carries the last `inputRedundancyFrames`
// snapshots; even with one drop, the next packet replays the missed
// frame, so the buffer converges on every peer.
class InputBuffer {
  private cells = new Map<string, InputBits>()
  // Track the highest frameId seen per player so the fallback returns the
  // latest-FRAME bits, not the latest-ARRIVAL bits. With ordered: false
  // datachannels, packets can arrive frame-N before frame-N-1; an
  // arrival-order fallback would diverge between peers because each peer
  // observes a different shuffle.
  private lastBitsByPlayer = new Map<string, InputBits>()
  private lastFrameByPlayer = new Map<string, number>()

  set(frameId: number, playerId: string, bits: InputBits): void {
    this.cells.set(`${frameId}|${playerId}`, bits)
    const prevMax = this.lastFrameByPlayer.get(playerId) ?? -1
    if (frameId > prevMax) {
      this.lastFrameByPlayer.set(playerId, frameId)
      this.lastBitsByPlayer.set(playerId, bits)
    }
  }

  // Resolve input for `frameId` and `playerId`. If the exact frame is
  // missing (a dropped + un-replayed packet, or a frame the sender
  // genuinely had no input for), fall back to the most recent
  // sender-frame's bits we have on record. Both peers compute the same
  // answer as long as their sets of received frames agree — which they
  // do once redundancy has replayed the missed packet.
  get(frameId: number, playerId: string): InputBits {
    const exact = this.cells.get(`${frameId}|${playerId}`)
    if (exact !== undefined) return exact
    return this.lastBitsByPlayer.get(playerId) ?? 0
  }

  prune(keepFromFrame: number): void {
    for (const k of this.cells.keys()) {
      const frame = Number(k.split('|')[0])
      if (frame < keepFromFrame) this.cells.delete(k)
    }
  }
}

class NetInputProvider implements InputProvider {
  // Per-player ring of the last `redundancy` (frame, bits) submissions.
  // Each broadcast packet carries the entire ring so a single drop on
  // the unordered + maxRetransmits=0 input channel gets repaired by the
  // next packet. Without this, both peers' InputBuffers diverge as soon
  // as one packet is lost — exactly the lockstep failure mode the
  // protocol design called out.
  private history = new Map<string, Array<{ frameId: number; bits: InputBits }>>()
  constructor(private buffer: InputBuffer, private inputDelay: number, private redundancy: number = 4) {}
  get(frameId: number, playerId: string): InputBits {
    return this.buffer.get(frameId, playerId)
  }
  submit(frameId: number, playerId: string, bits: InputBits): void {
    const scheduled = frameId + this.inputDelay
    this.buffer.set(scheduled, playerId, bits)

    const ring = this.history.get(playerId) ?? []
    ring.push({ frameId: scheduled, bits })
    while (ring.length > this.redundancy) ring.shift()
    this.history.set(playerId, ring)

    OiSving.Net?.broadcastInputBatch(playerId, ring)
  }
}

// Per-peer cache of locally-computed state-hash gossip values, keyed by
// the simulation frameId at which we hashed. Used to do frame-aligned
// drift detection regardless of when peers' wall clocks tick. Pending
// remote hashes that arrive before local catches up sit here too.
const localHashByFrame = new Map<number, number>()
const pendingRemoteHashes = new Map<number, number>()
const HASH_CACHE_RETAIN_FRAMES = 600 // ~10s at 60 fps

// Module-level mutable state. The singleton matches the existing OiSving
// module shape; tests inject via OiSving.Net.__setMockSocket.
let signalingSocket: WebSocket | null = null
let roomCode: string | null = null
let isHost = false
let localPeerId = ''
const peers = new Map<string, PeerSlot>()
const remotePlayerIdsByPeer = new Map<string, string[]>()
const events = new EventBus()
let inputBuffer = new InputBuffer()
let netProvider: NetInputProvider | null = null
let connectionState: 'idle' | 'signaling' | 'connecting' | 'open' | 'closed' = 'idle'
let localPlayerIds: string[] = []

function setConnState(s: typeof connectionState) {
  connectionState = s
  events.emit('connection-state', s)
}

function genPeerId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function normalizePlayerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set(PLAYER_ID_TABLE)
  return [...new Set(value.map(v => String(v)).filter(id => allowed.has(id)))]
}

interface HostSimConfig {
  inputDelayFrames: number
  stateHashIntervalFrames: number
  fps: number
  holeInterval: number
  holeIntervalRandomness: number
  initialSuperpowerCount: number
  allowedPlayerMask: number
  arenaWidth: number
  arenaHeight: number
}

function playerMaskToIds(mask: number): string[] {
  const ids: string[] = []
  for (let i = 0; i < PLAYER_ID_TABLE.length; i++) {
    if (mask & (1 << i)) ids.push(PLAYER_ID_TABLE[i])
  }
  return ids
}

function playerIdsToMask(ids: string[]): number {
  let mask = 0
  for (const id of ids) {
    const idx = PLAYER_ID_TABLE.indexOf(id)
    if (idx >= 0) mask |= 1 << idx
  }
  return mask
}

// Joiner side: clobber local OiSving.Config with host's authoritative values
// so simulation iteration draws the same RNG sequence on every peer. Game.fps
// also drives the tick interval, so reapply on Game directly. allowedPlayerMask
// trims OiSving.Config.Players to the host-allowed roster, which gates which
// colors a joiner can pick from the menu.
function applyHostConfig(cfg: HostSimConfig): void {
  const cfgRoot = OiSving.Config
  if (!cfgRoot) return

  if (cfgRoot.Net) {
    cfgRoot.Net.inputDelayFrames = cfg.inputDelayFrames
    cfgRoot.Net.stateHashIntervalFrames = cfg.stateHashIntervalFrames
    cfgRoot.Net.arenaWidth = cfg.arenaWidth
    cfgRoot.Net.arenaHeight = cfg.arenaHeight
  }
  if (cfgRoot.Game) {
    cfgRoot.Game.fps = cfg.fps
    cfgRoot.Game.initialSuperpowerCount = cfg.initialSuperpowerCount
  }
  if (cfgRoot.Curve) {
    cfgRoot.Curve.holeInterval = cfg.holeInterval
    cfgRoot.Curve.holeIntervalRandomness = cfg.holeIntervalRandomness
  }

  const allowedIds = playerMaskToIds(cfg.allowedPlayerMask)
  if (allowedIds.length > 0 && Array.isArray(cfgRoot.Players)) {
    cfgRoot.Players = cfgRoot.Players.filter((p: { id: string }) => allowedIds.includes(p.id))
  }

  // Game.fps was captured into Game.fps + Game.intervalTimeOut at init time.
  // If host's fps differs from joiner's compiled default, refresh the live
  // values so setInterval ticks at host's rate.
  if (OiSving.Game) {
    OiSving.Game.fps = cfg.fps
    OiSving.Game.intervalTimeOut = Math.round(1000 / cfg.fps)
  }
}

function getActivePlayerIds(): string[] {
  return (OiSving.players ?? [])
    .filter((p: { isActive?: () => boolean }) => p.isActive?.())
    .map((p: { getId: () => string }) => p.getId())
}


function getNetConfig() {
  const sameOriginSignalingUrl = () => {
    if (typeof window === 'undefined' || !window.location) return 'ws://localhost:8787/'
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/`
  }
  const cfg = OiSving.Config?.Net ?? {
    signalingUrl: null,
    stunServers: ['stun:stun.l.google.com:19302'],
    inputDelayFrames: 2,
    inputRedundancyFrames: 4,
    maxPeers: 6,
    arenaWidth: 1280,
    arenaHeight: 720,
  }
  return {
    ...cfg,
    signalingUrl: cfg.signalingUrl || sameOriginSignalingUrl(),
  }
}

function makePeerConnection(): RTCPeerConnection {
  const cfg = getNetConfig()
  return new RTCPeerConnection({
    iceServers: [{ urls: cfg.stunServers }],
  })
}

function openSignaling(url: string): WebSocket {
  setConnState('signaling')
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('close', () => setConnState('closed'))
  ws.addEventListener('error', () => setConnState('closed'))
  return ws
}

// ---------------------------------------------------------------------------
// Wire format helpers. All multi-byte ints big-endian for cross-runtime
// stability (V8/JSC/SpiderMonkey are all platform-dependent on TypedArray
// byte order, so we go through DataView).
// ---------------------------------------------------------------------------

// MSG_START is the host-authoritative round-start packet. Joiners reseed the
// RNG, override their local OiSving.Config sim values from these bytes, and
// then start the round. The host owns every byte here — joiner-side defaults
// in OiSvingConfig.ts are placeholders that get clobbered before the first
// frame ticks. Wire layout:
//   0       u8   MSG_START
//   1..4    u32  RNG seed
//   5..6    u16  arena width  (px in canonical sim space)
//   7..8    u16  arena height
//   9..12   u32  start frame id
//   13      u8   input delay frames
//   14      u8   state-hash gossip interval (frames)
//   15      u8   fps
//   16..17  u16  hole interval (frames between holes)
//   18..19  u16  hole interval randomness (extra random frames added)
//   20      u8   initial superpower count
//   21      u8   allowed-player bitmask (bit 0 = red, 1 = orange, ..., 5 = pink)
function encodeStart(
  seed: number,
  arenaWidth: number,
  arenaHeight: number,
  startFrame: number,
  inputDelayFrames: number,
  stateHashIntervalFrames: number,
  fps: number,
  holeInterval: number,
  holeIntervalRandomness: number,
  initialSuperpowerCount: number,
  allowedPlayerMask: number
): ArrayBuffer {
  const buf = new ArrayBuffer(22)
  const v = new DataView(buf)
  v.setUint8(0, MSG_START)
  v.setUint32(1, seed >>> 0)
  v.setUint16(5, arenaWidth)
  v.setUint16(7, arenaHeight)
  v.setUint32(9, startFrame)
  v.setUint8(13, inputDelayFrames & 0xff)
  v.setUint8(14, stateHashIntervalFrames & 0xff)
  v.setUint8(15, fps & 0xff)
  v.setUint16(16, holeInterval)
  v.setUint16(18, holeIntervalRandomness)
  v.setUint8(20, initialSuperpowerCount & 0xff)
  v.setUint8(21, allowedPlayerMask & 0xff)
  return buf
}

// Pack a redundancy window into a single MSG_INPUT packet. Wire layout:
//   0       u8   MSG_INPUT
//   1       u8   playerId index
//   2       u8   count (entries that follow)
//   3..N    per entry: u32 frameId + u8 bits
// One packet covering the last N submitted frames means a single drop on the
// unordered input channel is repaired by the next packet — both peers
// converge on identical buffer cells, which is what makes the lockstep
// fallback (latest-frame-bits) deterministic.
function encodeInputBatch(playerId: string, entries: Array<{ frameId: number; bits: InputBits }>): ArrayBuffer {
  const buf = new ArrayBuffer(3 + entries.length * 5)
  const v = new DataView(buf)
  v.setUint8(0, MSG_INPUT)
  v.setUint8(1, playerIdToByte(playerId))
  v.setUint8(2, entries.length & 0xff)
  for (let i = 0; i < entries.length; i++) {
    v.setUint32(3 + i * 5, entries[i].frameId)
    v.setUint8(3 + i * 5 + 4, entries[i].bits & 0xff)
  }
  return buf
}

function encodePause(): ArrayBuffer {
  const buf = new ArrayBuffer(1)
  new DataView(buf).setUint8(0, MSG_PAUSE)
  return buf
}

function encodeUnpause(): ArrayBuffer {
  const buf = new ArrayBuffer(1)
  new DataView(buf).setUint8(0, MSG_UNPAUSE)
  return buf
}

// Roster + claim/release messages carry a JSON payload after the type byte.
// JSON is overkill for size but the channel is reliable and these fire only
// on roster changes (small, infrequent), so the simplicity wins.
function encodeJsonMsg(type: number, payload: unknown): ArrayBuffer {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  const buf = new ArrayBuffer(1 + bytes.byteLength)
  new Uint8Array(buf, 0, 1)[0] = type
  new Uint8Array(buf, 1).set(bytes)
  return buf
}

function decodeJsonMsg(msg: ArrayBuffer): unknown {
  const view = new Uint8Array(msg, 1)
  const json = new TextDecoder().decode(view)
  try { return JSON.parse(json) } catch { return null }
}

function encodeStateHash(frameId: number, hash: number): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 4 + 4)
  const v = new DataView(buf)
  v.setUint8(0, MSG_STATE_HASH)
  v.setUint32(1, frameId)
  v.setUint32(5, hash >>> 0)
  return buf
}

const PLAYER_ID_TABLE = ['red', 'orange', 'green', 'blue', 'purple', 'pink']

function playerIdToByte(id: string): number {
  const idx = PLAYER_ID_TABLE.indexOf(id)
  return idx >= 0 ? idx : 0xff
}

function byteToPlayerId(b: number): string {
  return PLAYER_ID_TABLE[b] ?? 'red'
}

function dispatch(msg: ArrayBuffer, fromSlot: PeerSlot | null): void {
  const v = new DataView(msg)
  const type = v.getUint8(0)
  switch (type) {
    case MSG_START: {
      const seed = v.getUint32(1)
      const arenaWidth = v.getUint16(5)
      const arenaHeight = v.getUint16(7)
      const startFrame = v.getUint32(9)
      const inputDelay = v.getUint8(13)
      const hashInterval = v.getUint8(14)
      const fps = v.getUint8(15)
      const holeInterval = v.getUint16(16)
      const holeRandom = v.getUint16(18)
      const initialSp = v.getUint8(20)
      const allowedMask = v.getUint8(21)

      // Apply host's authoritative simulation config before constructing
      // anything that reads it. Host owns the rules — joiner's compiled
      // defaults are placeholders we deliberately overwrite here so a
      // joiner running a slightly different build cannot diverge.
      applyHostConfig({
        inputDelayFrames: inputDelay,
        stateHashIntervalFrames: hashInterval,
        fps,
        holeInterval,
        holeIntervalRandomness: holeRandom,
        initialSuperpowerCount: initialSp,
        allowedPlayerMask: allowedMask,
        arenaWidth,
        arenaHeight,
      })

      setSimRng(new Rng(seed))
      OiSving.Field?.setArenaSize?.(arenaWidth, arenaHeight)
      // Joiner side: install the network input provider so curves read
      // through the lockstep buffer. Host calls startRound() locally and
      // installs the provider there.
      inputBuffer = new InputBuffer()
      netProvider = new NetInputProvider(inputBuffer, inputDelay)
      setInputProvider(netProvider)
      // Align this peer's frame counter to the host's so input frame ids
      // line up. Game has not necessarily started yet — once it does its
      // CURRENT_FRAME_ID will tick from `startFrame`.
      if (OiSving.Game) OiSving.Game.CURRENT_FRAME_ID = startFrame
      events.emit('round-start', seed, arenaWidth, arenaHeight, startFrame)
      return
    }
    case MSG_INPUT: {
      // Batch decode: each packet carries a redundancy window of
      // recent (frame, bits) entries for one player. Setting all of
      // them is idempotent because InputBuffer.set is a write-by-key.
      const playerId = byteToPlayerId(v.getUint8(1))
      const count = v.getUint8(2)
      for (let i = 0; i < count; i++) {
        const frameId = v.getUint32(3 + i * 5)
        const bits = v.getUint8(3 + i * 5 + 4)
        inputBuffer.set(frameId, playerId, bits)
      }
      return
    }
    case MSG_LEAVE: {
      // Roster update would live here. Curve just drives straight using
      // the deterministic-fallback policy in InputBuffer.get.
      return
    }
    case MSG_PAUSE: {
      events.emit('pause')
      return
    }
    case MSG_UNPAUSE: {
      events.emit('unpause')
      return
    }
    case MSG_ROSTER: {
      // Authoritative roster from host. Clobber local view and re-emit
      // player-joined/left for the diff so menu lock state reconciles.
      const snapshot = decodeJsonMsg(msg) as RosterSnapshot | null
      if (snapshot && typeof snapshot === 'object') applyRosterSnapshot(snapshot)
      return
    }
    case MSG_CLAIM: {
      // Joiner asked to claim a player id. Host validates and rebroadcasts
      // the roster. Joiners receiving this would have nothing to do —
      // claim is a request to the host, not a state change in itself.
      if (!isHost || !fromSlot) return
      const claim = decodeJsonMsg(msg) as { playerId?: string } | null
      if (!claim?.playerId) return
      hostHandleClaim(fromSlot.peerId, claim.playerId)
      return
    }
    case MSG_RELEASE: {
      if (!isHost || !fromSlot) return
      const rel = decodeJsonMsg(msg) as { playerId?: string } | null
      if (!rel?.playerId) return
      hostHandleRelease(fromSlot.peerId, rel.playerId)
      return
    }
    case MSG_STATE_HASH: {
      // Compare host's hash for frame N against THIS peer's recorded
      // hash for frame N — not its current state. Recomputing now would
      // diff host-state-at-N against local-state-at-(N+k) where k is
      // the wall-clock skew (network RTT + per-peer start-delay drift).
      // That's a guaranteed false positive even when the simulation is
      // perfectly deterministic. Each peer caches its own gossip hash
      // in localHashByFrame so this comparison is always frame-aligned.
      const frameId = v.getUint32(1)
      const remoteHash = v.getUint32(5)
      const myHashAtFrame = localHashByFrame.get(frameId)
      if (typeof myHashAtFrame === 'number') {
        if (myHashAtFrame !== remoteHash) {
          events.emit('state-hash-mismatch', frameId, remoteHash, myHashAtFrame)
        }
      } else {
        // Local peer is behind; remember the remote claim and compare
        // when our own gossip for that frame fires.
        pendingRemoteHashes.set(frameId, remoteHash)
      }
      return
    }
    default:
      return
  }
}

function attachDataChannel(slot: PeerSlot, ch: RTCDataChannel, label: 'control' | 'input'): void {
  ch.binaryType = 'arraybuffer'
  ch.addEventListener('open', () => {
    if (label === 'control') slot.control = ch
    else slot.input = ch
    setConnState('open')
    flushOutbound(slot)
  })
  ch.addEventListener('close', () => {
    if (label === 'control') slot.control = null
    else slot.input = null
  })
  ch.addEventListener('message', evt => {
    if (typeof evt.data === 'string') return
    dispatch(evt.data as ArrayBuffer, slot)
  })
}

function flushOutbound(slot: PeerSlot): void {
  const remaining: PeerSlot['outboundQueue'] = []
  for (const item of slot.outboundQueue) {
    const ch = item.channel === 'control' ? slot.control : slot.input
    if (ch && ch.readyState === 'open') ch.send(item.msg)
    else remaining.push(item)
  }
  slot.outboundQueue = remaining
}

function broadcast(channel: 'control' | 'input', msg: ArrayBuffer): void {
  for (const slot of peers.values()) {
    const ch = channel === 'control' ? slot.control : slot.input
    if (ch && ch.readyState === 'open') {
      ch.send(msg)
    } else {
      slot.outboundQueue.push({ channel, msg })
    }
  }
}

// ---------------------------------------------------------------------------
// Roster authority. Host owns the truth; joiners send claim/release requests
// and reconcile from the broadcast snapshot. The host never trusts a
// joiner's local view.
// ---------------------------------------------------------------------------

function buildRosterSnapshot(): RosterSnapshot {
  return {
    hostPeerId: isHost ? localPeerId : (hostPeerIdFromJoinerView ?? ''),
    hostPlayerIds: isHost ? [...localPlayerIds] : [...(remotePlayerIdsByPeer.get(hostPeerIdFromJoinerView ?? '') ?? [])],
    joiners: isHost
      ? [...remotePlayerIdsByPeer.entries()].map(([peerId, playerIds]) => ({ peerId, playerIds: [...playerIds] }))
      : [{ peerId: localPeerId, playerIds: [...localPlayerIds] }],
  }
}

function broadcastRoster(): void {
  if (!isHost) return
  const snap = buildRosterSnapshot()
  broadcast('control', encodeJsonMsg(MSG_ROSTER, snap))
  // Host emits its own roster-update locally too so its menu reconciles
  // off the same code path joiners use.
  events.emit('roster-update', snap)
}

function rosterContainsPlayerId(playerId: string): { peerId: string } | null {
  if (isHost) {
    if (localPlayerIds.includes(playerId)) return { peerId: localPeerId }
    for (const [peerId, ids] of remotePlayerIdsByPeer) {
      if (ids.includes(playerId)) return { peerId }
    }
  } else {
    for (const [peerId, ids] of remotePlayerIdsByPeer) {
      if (ids.includes(playerId)) return { peerId }
    }
    if (localPlayerIds.includes(playerId)) return { peerId: localPeerId }
  }
  return null
}

function getAllowedPlayerIds(): string[] {
  const cfgPlayers = OiSving.Config?.Players
  return Array.isArray(cfgPlayers) ? cfgPlayers.map((p: { id: string }) => p.id) : [...PLAYER_ID_TABLE]
}

function hostHandleClaim(fromPeerId: string, playerId: string): void {
  if (!isHost) return
  if (!getAllowedPlayerIds().includes(playerId)) {
    // Reject silently; rebroadcast roster so the requester reverts.
    broadcastRoster()
    return
  }
  if (rosterContainsPlayerId(playerId)) {
    broadcastRoster()
    return
  }
  if (fromPeerId === localPeerId) {
    if (!localPlayerIds.includes(playerId)) localPlayerIds.push(playerId)
  } else {
    const existing = remotePlayerIdsByPeer.get(fromPeerId) ?? []
    if (!existing.includes(playerId)) {
      remotePlayerIdsByPeer.set(fromPeerId, [...existing, playerId])
    }
  }
  broadcastRoster()
}

function hostHandleRelease(fromPeerId: string, playerId: string): void {
  if (!isHost) return
  if (fromPeerId === localPeerId) {
    localPlayerIds = localPlayerIds.filter(id => id !== playerId)
  } else {
    const existing = remotePlayerIdsByPeer.get(fromPeerId)
    if (existing) {
      remotePlayerIdsByPeer.set(fromPeerId, existing.filter(id => id !== playerId))
    }
  }
  broadcastRoster()
}

function applyRosterSnapshot(snap: RosterSnapshot): void {
  // Joiner-side reconcile. Compute diff vs current view, apply, emit
  // player-joined/left so menu lock state catches up.
  const previousRemote = new Map<string, string[]>(remotePlayerIdsByPeer)
  const previousLocal = [...localPlayerIds]

  remotePlayerIdsByPeer.clear()
  if (snap.hostPeerId && snap.hostPeerId !== localPeerId) {
    remotePlayerIdsByPeer.set(snap.hostPeerId, [...(snap.hostPlayerIds ?? [])])
    hostPeerIdFromJoinerView = snap.hostPeerId
  }
  for (const j of snap.joiners ?? []) {
    if (j.peerId === localPeerId) {
      // Host says my new local ids are these. Trust it.
      localPlayerIds = [...(j.playerIds ?? [])]
    } else {
      remotePlayerIdsByPeer.set(j.peerId, [...(j.playerIds ?? [])])
    }
  }
  // If host did not include this peer at all, our local roster collapses.
  if (!snap.joiners?.some(j => j.peerId === localPeerId) && !isHost) {
    localPlayerIds = []
  }

  const previousRemoteFlat = new Set([...previousRemote.values()].flat())
  const currentRemoteFlat = new Set([...remotePlayerIdsByPeer.values()].flat())
  for (const id of previousRemoteFlat) {
    if (!currentRemoteFlat.has(id)) events.emit('player-left', { peerId: '', playerId: id, isLocal: false })
  }
  for (const id of currentRemoteFlat) {
    if (!previousRemoteFlat.has(id)) events.emit('player-joined', { peerId: '', playerId: id, isLocal: false })
  }
  // Local-side: surface revoked/added ids so menu visuals match host truth.
  for (const id of previousLocal) {
    if (!localPlayerIds.includes(id)) events.emit('player-left', { peerId: localPeerId, playerId: id, isLocal: true })
  }
  for (const id of localPlayerIds) {
    if (!previousLocal.includes(id)) events.emit('player-joined', { peerId: localPeerId, playerId: id, isLocal: true })
  }
  events.emit('roster-update', snap)
}

let hostPeerIdFromJoinerView: string | null = null

// ---------------------------------------------------------------------------
// Public OiSving.Net surface. Game/Menu/Curve consume this object.
// ---------------------------------------------------------------------------

OiSving.Net = {
  isActive(): boolean {
    return signalingSocket !== null || peers.size > 0
  },

  isHost(): boolean {
    return isHost
  },

  getRoomCode(): string | null {
    return roomCode
  },

  getLocalPlayerIds(): string[] {
    return localPlayerIds.length > 0 ? [...localPlayerIds] : getActivePlayerIds()
  },

  getRemotePlayerIds(): string[] {
    return [...new Set([...remotePlayerIdsByPeer.values()].flat())]
  },

  on<E extends EventName>(name: E, fn: NetEvents[E]): () => void {
    return events.on(name, fn)
  },

  async host(): Promise<string> {
    const cfg = getNetConfig()
    // Host can run with zero local players ("host-only mode"). The
    // ≥2-players gate is enforced in startRound, not here.
    localPlayerIds = getActivePlayerIds()
    remotePlayerIdsByPeer.clear()
    hostPeerIdFromJoinerView = null
    isHost = true
    localPeerId = genPeerId()
    signalingSocket = openSignaling(cfg.signalingUrl)
    return new Promise<string>((resolve, reject) => {
      const ws = signalingSocket!
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'host', peerId: localPeerId, playerIds: localPlayerIds }))
      })
      ws.addEventListener('message', async evt => {
        const data = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data))
        if (data.type === 'hosted') {
          roomCode = data.code
          resolve(roomCode!)
        } else if (data.type === 'peer-joined') {
          const playerIds = normalizePlayerIds(data.playerIds)
          remotePlayerIdsByPeer.set(data.peerId, playerIds)
          for (const playerId of playerIds) {
            events.emit('player-joined', { peerId: data.peerId, playerId, isLocal: false })
          }
          // Send the new joiner the authoritative roster as soon as the
          // RTC channel comes up. flushOutbound replays this if the
          // datachannel is not open yet.
          broadcastRoster()
        } else if (data.type === 'peer-left') {
          // Joiner navigated away or refreshed. Surface as player-left so
          // menus unlock that color, and rebroadcast the new roster so
          // every other peer sees the same authoritative state.
          const departedPlayerIds = remotePlayerIdsByPeer.get(data.peerId) ?? []
          remotePlayerIdsByPeer.delete(data.peerId)
          for (const playerId of departedPlayerIds) {
            events.emit('player-left', { peerId: data.peerId, playerId, isLocal: false })
          }
          broadcastRoster()
        } else if (data.type === 'offer') {
          await handleOffer(data.from, data.sdp, ws)
        } else if (data.type === 'ice') {
          const slot = peers.get(data.from)
          if (slot && data.candidate) await slot.pc.addIceCandidate(data.candidate)
        } else if (data.type === 'error') {
          reject(new Error(data.message ?? 'signaling error'))
        }
      })
      ws.addEventListener('error', reject)
    })
  },

  async join(code: string): Promise<void> {
    const cfg = getNetConfig()
    // Joiner can connect with zero local players. New flow: connect first,
    // see which colors are taken in the host-broadcast roster, then claim.
    localPlayerIds = getActivePlayerIds()
    remotePlayerIdsByPeer.clear()
    hostPeerIdFromJoinerView = null
    isHost = false
    localPeerId = genPeerId()
    roomCode = code
    signalingSocket = openSignaling(cfg.signalingUrl)
    return new Promise<void>((resolve, reject) => {
      const ws = signalingSocket!
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join', code, peerId: localPeerId, playerIds: localPlayerIds }))
      })
      ws.addEventListener('message', async evt => {
        const data = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data))
        if (data.type === 'joined') {
          const hostPlayerIds = normalizePlayerIds(data.hostPlayerIds)
          remotePlayerIdsByPeer.set(data.hostId, hostPlayerIds)
          hostPeerIdFromJoinerView = data.hostId
          for (const playerId of hostPlayerIds) {
            events.emit('player-joined', { peerId: data.hostId, playerId, isLocal: false })
          }
          await initiateConnection(data.hostId, ws)
          resolve()
        } else if (data.type === 'host-gone') {
          // Server drops the room when the host disconnects. Surface a
          // connection-closed signal so UI can fall back to the menu.
          setConnState('closed')
          for (const ids of remotePlayerIdsByPeer.values()) {
            for (const playerId of ids) {
              events.emit('player-left', { peerId: '', playerId, isLocal: false })
            }
          }
          remotePlayerIdsByPeer.clear()
        } else if (data.type === 'answer') {
          const slot = peers.get(data.from)
          if (slot) await slot.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
        } else if (data.type === 'ice') {
          const slot = peers.get(data.from)
          if (slot && data.candidate) await slot.pc.addIceCandidate(data.candidate)
        } else if (data.type === 'error') {
          reject(new Error(data.message ?? 'signaling error'))
        }
      })
      ws.addEventListener('error', reject)
    })
  },

  // Joiner-side: tell the host we want a color. Host validates and
  // rebroadcasts the roster. Host-side: directly accept the claim and
  // rebroadcast (no roundtrip needed).
  claimPlayer(playerId: string): void {
    if (isHost) {
      hostHandleClaim(localPeerId, playerId)
      return
    }
    broadcast('control', encodeJsonMsg(MSG_CLAIM, { playerId }))
  },

  releasePlayer(playerId: string): void {
    if (isHost) {
      hostHandleRelease(localPeerId, playerId)
      return
    }
    broadcast('control', encodeJsonMsg(MSG_RELEASE, { playerId }))
  },

  // ≥2 players combined (local + remote) is required to start a round.
  // UI uses this to enable/disable the Start Game button.
  canStartRound(): boolean {
    if (!isHost) return false
    const total = localPlayerIds.length + [...remotePlayerIdsByPeer.values()].reduce((acc, ids) => acc + ids.length, 0)
    return total >= 2
  },

  // Fetch active rooms from the LAN signaling server. Same origin by
  // default; a custom signalingUrl maps ws:// → http:// for the GET.
  async listRooms(): Promise<Array<{ code: string; hostPlayerIds: string[]; joinerCount: number }>> {
    const cfg = getNetConfig()
    const wsUrl = cfg.signalingUrl
    let httpUrl: string
    if (typeof window !== 'undefined' && window.location && (!wsUrl || wsUrl.startsWith('ws') === false)) {
      httpUrl = `${window.location.origin}/rooms`
    } else {
      httpUrl = wsUrl.replace(/^wss?:\/\//, (m: string) => (m === 'wss://' ? 'https://' : 'http://')).replace(/\/$/, '') + '/rooms'
    }
    try {
      const res = await fetch(httpUrl, { cache: 'no-store' })
      if (!res.ok) return []
      const body = await res.json() as { rooms?: Array<{ code: string; hostPlayerIds: string[]; joinerCount: number }> }
      return body.rooms ?? []
    } catch {
      return []
    }
  },

  startRound(seed: number, arenaWidth: number, arenaHeight: number, startFrame = 0): void {
    if (!isHost) throw new Error('startRound is host-only')
    setSimRng(new Rng(seed))
    OiSving.Field?.setArenaSize?.(arenaWidth, arenaHeight)

    // Host snapshots its own simulation config and ships it to every joiner
    // so they overwrite local defaults before NetInputProvider/Game read
    // them. This is what makes the host authoritative for rules: input
    // delay, hash interval, fps, hole interval, hole randomness, initial
    // superpower count, and the allowed-color list all come from here.
    const cfgRoot = OiSving.Config ?? {}
    const netCfg = cfgRoot.Net ?? {}
    const gameCfg = cfgRoot.Game ?? {}
    const curveCfg = cfgRoot.Curve ?? {}
    const inputDelay = (netCfg.inputDelayFrames ?? 2) | 0
    const hashInterval = (netCfg.stateHashIntervalFrames ?? 60) | 0
    const fps = (gameCfg.fps ?? 60) | 0
    const holeInterval = (curveCfg.holeInterval ?? 150) | 0
    const holeRandom = (curveCfg.holeIntervalRandomness ?? 300) | 0
    const initialSp = (gameCfg.initialSuperpowerCount ?? 2) | 0
    const allowedIds: string[] = Array.isArray(cfgRoot.Players)
      ? (cfgRoot.Players as { id: string }[]).map(p => p.id)
      : [...PLAYER_ID_TABLE]
    const allowedMask = playerIdsToMask(allowedIds)

    inputBuffer = new InputBuffer()
    netProvider = new NetInputProvider(inputBuffer, inputDelay)
    setInputProvider(netProvider)
    broadcast('control', encodeStart(
      seed, arenaWidth, arenaHeight, startFrame,
      inputDelay, hashInterval, fps,
      holeInterval, holeRandom, initialSp, allowedMask,
    ))
    events.emit('round-start', seed, arenaWidth, arenaHeight, startFrame)
  },

  // Same delay applied to remote peers and to the local simulation, so own
  // input never feels snappier than remote input on any peer.
  sendLocalInputs(frameId: number, playerId: string, bits: InputBits): void {
    if (!netProvider) return
    netProvider.submit(frameId, playerId, bits)
  },

  // Used internally by NetInputProvider.submit. Sends the full
  // redundancy window in one packet so a single drop on the unordered
  // input channel is repaired by the next submission.
  broadcastInputBatch(playerId: string, entries: Array<{ frameId: number; bits: InputBits }>): void {
    if (entries.length === 0) return
    broadcast('input', encodeInputBatch(playerId, entries))
  },

  getInputsForFrame(frameId: number, playerId: string): InputBits {
    return inputBuffer.get(frameId, playerId)
  },

  pruneInputs(keepFromFrame: number): void {
    inputBuffer.prune(keepFromFrame)
  },

  reportStateHash(frameId: number, hash: number): void {
    // Cache locally so MSG_STATE_HASH dispatch can do frame-aligned
    // comparison instead of recomputing current state at receive time.
    // Resolve any pending remote hash for the same frame now that we
    // have a value to compare against.
    localHashByFrame.set(frameId, hash)
    const cutoff = frameId - HASH_CACHE_RETAIN_FRAMES
    for (const f of localHashByFrame.keys()) {
      if (f < cutoff) localHashByFrame.delete(f)
    }
    const pending = pendingRemoteHashes.get(frameId)
    if (typeof pending === 'number') {
      pendingRemoteHashes.delete(frameId)
      if (pending !== hash) events.emit('state-hash-mismatch', frameId, pending, hash)
    }
    for (const f of pendingRemoteHashes.keys()) {
      if (f < cutoff) pendingRemoteHashes.delete(f)
    }
    broadcast('control', encodeStateHash(frameId, hash))
  },

  // Host-only. Authoritative pause/unpause: host's space press fans out to
  // every joiner so all peers freeze and resume their tick loops together.
  // Joiners never call these directly — Game.onSpaceDown gates them out.
  broadcastPause(): void {
    if (!isHost) return
    broadcast('control', encodePause())
  },

  broadcastUnpause(): void {
    if (!isHost) return
    broadcast('control', encodeUnpause())
  },

  // Joiner-only UI helper. Called from the inline join handler after a
  // successful Net.join so the joiner sees that they have connected and
  // are now waiting on the host. Renders inline above the player list
  // (NOT a blocking modal) so the joiner can still pick a color while
  // waiting. The 'round-start' listener in OiSving.Game.init hides it
  // when the host kicks the round off.
  showWaitingForHost(): void {
    if (typeof document === 'undefined') return
    const el = document.getElementById('waiting-host-banner')
    if (el) el.classList.remove('hidden')
  },

  hideWaitingForHost(): void {
    if (typeof document === 'undefined') return
    const el = document.getElementById('waiting-host-banner')
    if (el) el.classList.add('hidden')
  },

  // Constants re-exported for legacy code paths reading via OiSving.Net.
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_SUPERPOWER,
}

async function initiateConnection(remotePeerId: string, ws: WebSocket): Promise<void> {
  const pc = makePeerConnection()
  const slot: PeerSlot = {
    peerId: remotePeerId,
    pc,
    control: null,
    input: null,
    playerId: '',
    outboundQueue: [],
  }
  peers.set(remotePeerId, slot)
  setConnState('connecting')

  const control = pc.createDataChannel('control', { ordered: true })
  attachDataChannel(slot, control, 'control')
  const input = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 })
  attachDataChannel(slot, input, 'input')

  pc.addEventListener('icecandidate', evt => {
    if (evt.candidate) {
      ws.send(JSON.stringify({ type: 'ice', to: remotePeerId, candidate: evt.candidate.toJSON() }))
    }
  })

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  ws.send(JSON.stringify({ type: 'offer', to: remotePeerId, sdp: offer.sdp }))
}

async function handleOffer(remotePeerId: string, sdp: string, ws: WebSocket): Promise<void> {
  const pc = makePeerConnection()
  const slot: PeerSlot = {
    peerId: remotePeerId,
    pc,
    control: null,
    input: null,
    playerId: '',
    outboundQueue: [],
  }
  peers.set(remotePeerId, slot)
  setConnState('connecting')

  pc.addEventListener('datachannel', evt => {
    if (evt.channel.label === 'control') attachDataChannel(slot, evt.channel, 'control')
    else if (evt.channel.label === 'input') attachDataChannel(slot, evt.channel, 'input')
  })
  pc.addEventListener('icecandidate', evt => {
    if (evt.candidate) {
      ws.send(JSON.stringify({ type: 'ice', to: remotePeerId, candidate: evt.candidate.toJSON() }))
    }
  })

  await pc.setRemoteDescription({ type: 'offer', sdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  ws.send(JSON.stringify({ type: 'answer', to: remotePeerId, sdp: answer.sdp }))
}
