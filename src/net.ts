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
import { InputBuffer } from './input-buffer'
import { Rng, setSimRng } from './rng'
import {
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_SUPERPOWER,
  type InputBits,
  setInputProvider,
} from './input-provider'
import {
  MSG_START,
  MSG_INPUT,
  MSG_LEAVE,
  MSG_STATE_HASH,
  MSG_PAUSE,
  MSG_UNPAUSE,
  MSG_ROSTER,
  MSG_CLAIM,
  MSG_RELEASE,
  MSG_HOST_STATE,
  PLAYER_ID_TABLE,
  playerIdsToMask,
  encodeStart,
  encodeInputBatch,
  encodeStateHash,
  encodePause,
  encodeUnpause,
  encodeJsonMsg,
  decodeJsonMsg,
  decodeStart,
  decodeInputBatch,
  decodeStateHash,
} from './net-protocol'

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
  'host-gone': () => void
  'peer-online': (entry: PeerInfo) => void
  'peer-offline': (entry: { peerId: string }) => void
  'connection-state': (state: 'idle' | 'signaling' | 'connecting' | 'open' | 'closed') => void
}

export interface PeerInfo {
  peerId: string
  address: string | null
  hostname: string | null
}

// Authoritative roster broadcast by the host on every claim/release/leave.
// Joiners overwrite their local view with this; menus and lock states are
// rebuilt from it.
export interface RosterSnapshot {
  hostPeerId: string
  hostPlayerIds: string[]
  joiners: Array<{ peerId: string; playerIds: string[] }>
}

export interface HostCurveState {
  playerId: string
  alive: boolean
  x: number
  y: number
  nextX: number
  nextY: number
  angle: number
  holeCountDown: number
  invisible: boolean
}

export interface HostPlayerState {
  playerId: string
  points: number
  superpowerCount: number
}

export interface HostStateSnapshot {
  frameId: number
  isRoundStarted: boolean
  isRunning: boolean
  curves: HostCurveState[]
  players: HostPlayerState[]
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

import { NetInputProvider } from './net-input-provider'
import { diffRosterSnapshot } from './roster'
import { applyHostConfig as applyHostConfigCore, type HostSimConfig } from './host-config'
import {
  canStartRoundFromState,
  peerOwnsPlayerIdFromRoster,
  type PeerChannelState,
} from './net-guards'
import { decideClaim, decideRelease } from './host-roster-validator'
import { StateHashCompare } from './state-hash-compare'

function applyHostConfig(cfg: HostSimConfig): void {
  applyHostConfigCore(cfg, OiSving.Config, OiSving.Game)
}

const broadcastInputViaNet = (playerId: string, ring: Array<{ frameId: number; bits: InputBits }>) => {
  OiSving.Net?.broadcastInputBatch(playerId, ring)
}

// Frame-aligned drift detection. Extracted into StateHashCompare so the
// comparison logic can be unit-tested without booting WebRTC; see
// src/state-hash-compare.ts for the why behind the two-map design.
const HASH_CACHE_RETAIN_FRAMES = 600 // ~10s at 60 fps
let hashCompare = new StateHashCompare(HASH_CACHE_RETAIN_FRAMES)

// Module-level mutable state. The singleton matches the existing OiSving
// module shape; tests inject via OiSving.Net.__setMockSocket.
let signalingSocket: WebSocket | null = null
let roomCode: string | null = null
let isHost = false
let localPeerId = ''
const peers = new Map<string, PeerSlot>()
const remotePlayerIdsByPeer = new Map<string, string[]>()
const peerInfoByPeer = new Map<string, { address: string | null; hostname: string | null }>()
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
  const allowed: ReadonlySet<string> = new Set<string>(PLAYER_ID_TABLE)
  return [...new Set(value.map(v => String(v)).filter(id => allowed.has(id)))]
}

// HostSimConfig + applyHostConfig live in src/host-config.ts so the
// joiner-side override logic can be unit-tested without the OiSving
// namespace. The wrapper here just plugs in the real refs.

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
//   22      u8   input redundancy frames (entries packed per MSG_INPUT)
//
// Backward compat: joiners running an older build still treat byte 22 as
// "first byte after the packet", so a longer host packet is harmless to
// them — they fall back to their compiled default redundancy. New
// joiners receiving an older host's 22-byte packet default to redundancy=4
// via length-bound decode (see dispatch).
function dispatch(msg: ArrayBuffer, fromSlot: PeerSlot | null): void {
  if (msg.byteLength < 1) return
  const v = new DataView(msg)
  const type = v.getUint8(0)
  switch (type) {
    case MSG_START: {
      // Decoder bails on truncated packets (returns ZERO_START with
      // arenaWidth=0). Skip apply if width is zero so a malformed packet
      // can't reset our config to junk.
      const start = decodeStart(msg)
      if (start.arenaWidth === 0 || start.arenaHeight === 0) return

      // Apply host's authoritative simulation config before constructing
      // anything that reads it. Host owns the rules — joiner's compiled
      // defaults are placeholders we deliberately overwrite here so a
      // joiner running a slightly different build cannot diverge.
      applyHostConfig({
        inputDelayFrames: start.inputDelayFrames,
        inputRedundancyFrames: start.inputRedundancyFrames,
        stateHashIntervalFrames: start.stateHashIntervalFrames,
        fps: start.fps,
        holeInterval: start.holeInterval,
        holeIntervalRandomness: start.holeIntervalRandomness,
        initialSuperpowerCount: start.initialSuperpowerCount,
        allowedPlayerMask: start.allowedPlayerMask,
        arenaWidth: start.arenaWidth,
        arenaHeight: start.arenaHeight,
      })

      setSimRng(new Rng(start.seed))
      OiSving.Field?.setArenaSize?.(start.arenaWidth, start.arenaHeight)
      // Joiner side: install the network input provider so curves read
      // through the lockstep buffer. Host calls startRound() locally and
      // installs the provider there.
      inputBuffer = new InputBuffer()
      netProvider = new NetInputProvider(inputBuffer, start.inputDelayFrames, start.inputRedundancyFrames, broadcastInputViaNet)
      setInputProvider(netProvider)
      // Align this peer's frame counter to the host's so input frame ids
      // line up. Game has not necessarily started yet — once it does its
      // CURRENT_FRAME_ID will tick from `startFrame`.
      if (OiSving.Game) OiSving.Game.CURRENT_FRAME_ID = start.startFrame
      events.emit('round-start', start.seed, start.arenaWidth, start.arenaHeight, start.startFrame)
      return
    }
    case MSG_INPUT: {
      // Batch decode: each packet carries a redundancy window of
      // recent (frame, bits) entries for one player. Setting all of
      // them is idempotent because InputBuffer.set is a write-by-key.
      // decodeInputBatch bounds the entry loop on actual buffer length,
      // so a malicious peer cannot trigger RangeError via inflated count.
      const batch = decodeInputBatch(msg)
      // Drop on out-of-range player byte (decodeInputBatch returns null)
      // so the dispatcher cannot apply input to a fallback color the
      // sender didn't intend.
      if (!batch.playerId) return
      // Roster authority: a peer may only submit inputs for players it
      // has been assigned. Drop INPUT messages that don't satisfy that
      // — otherwise a buggy or malicious peer could overwrite somebody
      // else's bits and steer their curve.
      if (fromSlot && !peerOwnsPlayerId(fromSlot.peerId, batch.playerId)) return
      for (const entry of batch.entries) {
        inputBuffer.set(entry.frameId, batch.playerId, entry.bits)
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
    case MSG_HOST_STATE: {
      if (isHost) return
      if (fromSlot && fromSlot.peerId !== hostPeerIdFromJoinerView) return
      const snap = decodeJsonMsg(msg) as HostStateSnapshot | null
      if (snap && typeof snap === 'object') {
        OiSving.Game?.applyHostStateSnapshot?.(snap)
      }
      return
    }
    case MSG_STATE_HASH: {
      if (!isHost) return
      // Compare host's hash for frame N against THIS peer's recorded
      // hash for frame N — not its current state. Recomputing now would
      // diff host-state-at-N against local-state-at-(N+k) where k is
      // the wall-clock skew (network RTT + per-peer start-delay drift).
      // That's a guaranteed false positive even when the simulation is
      // perfectly deterministic. StateHashCompare manages the
      // local/pending-remote split so this comparison is always
      // frame-aligned regardless of arrival order.
      // decodeStateHash returns zeros on a truncated buffer, which is
      // harmless: we only emit a mismatch when our own hash for that
      // frame has been recorded, and frame 0 won't exist there.
      if (msg.byteLength < 9) return
      const { frameId, hash: remoteHash } = decodeStateHash(msg)
      const event = hashCompare.reportRemote(frameId, remoteHash)
      if (event) events.emit('state-hash-mismatch', event.frameId, event.expected, event.actual)
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
    // Re-broadcast the authoritative roster the moment a NEW joiner's
    // control channel opens. The earlier broadcastRoster in the
    // signaling 'peer-joined' handler runs before this slot's data
    // channel exists, so a 3rd-or-later joiner would never see the
    // existing roster (and would therefore miss other joiners' colors,
    // their PeerSlot entries, and their initial player-joined events).
    // Sending the snapshot directly to this slot fills the gap without
    // requiring another claim/release event in the room.
    if (label === 'control' && isHost) {
      const snap = buildRosterSnapshot()
      const msg = encodeJsonMsg(MSG_ROSTER, snap)
      const target = slot.control
      if (target && target.readyState === 'open') target.send(msg)
      else slot.outboundQueue.push({ channel: 'control', msg })
    }
  })
  ch.addEventListener('close', () => {
    if (label === 'control') slot.control = null
    else slot.input = null
  })
  ch.addEventListener('message', evt => {
    if (typeof evt.data === 'string') return
    // Drop malformed packets quietly. Decoders bail on truncated buffers
    // (returning safe defaults), but defense-in-depth: any uncaught
    // throw in dispatch otherwise propagates as an unhandled exception
    // out of the RTCDataChannel listener and clutters the console with
    // every malformed packet a peer sends. One quiet drop is preferable.
    try {
      dispatch(evt.data as ArrayBuffer, slot)
    } catch {
      // Intentionally swallowed.
    }
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

function peerOwnsPlayerId(peerId: string, playerId: string): boolean {
  // Authoritative on the host (live roster maps); on joiners we trust
  // the host's most recent broadcast snapshot, which lives in the same
  // maps after applyRosterSnapshot. Known peers with no claimed players
  // are deliberately denied — a connected-but-unclaimed peer does not
  // get to submit input for somebody else's color.
  return peerOwnsPlayerIdFromRoster(remotePlayerIdsByPeer, localPeerId, localPlayerIds, peerId, playerId)
}

function peerChannelStates(): Map<string, PeerChannelState> {
  const out = new Map<string, PeerChannelState>()
  for (const [peerId, slot] of peers) {
    out.set(peerId, {
      controlOpen: slot.control?.readyState === 'open',
      inputOpen: slot.input?.readyState === 'open',
    })
  }
  return out
}

function canStartAuthoritativeRound(): boolean {
  return canStartRoundFromState(isHost, localPlayerIds, remotePlayerIdsByPeer, peerChannelStates())
}

function getAllowedPlayerIds(): string[] {
  const cfgPlayers = OiSving.Config?.Players
  return Array.isArray(cfgPlayers) ? cfgPlayers.map((p: { id: string }) => p.id) : [...PLAYER_ID_TABLE]
}

function hostHandleClaim(fromPeerId: string, playerId: string): void {
  if (!isHost) return
  const decision = decideClaim({
    fromPeerId,
    localPeerId,
    playerId,
    allowedPlayerIds: new Set(getAllowedPlayerIds()),
    localPlayerIds,
    remotePlayerIdsByPeer,
  })
  if (decision.kind !== 'accept') {
    // Reject silently; rebroadcast roster so the requester reverts.
    broadcastRoster()
    return
  }
  if (decision.isLocal) {
    if (!localPlayerIds.includes(playerId)) localPlayerIds.push(playerId)
  } else {
    const existing = remotePlayerIdsByPeer.get(fromPeerId) ?? []
    if (!existing.includes(playerId)) {
      remotePlayerIdsByPeer.set(fromPeerId, [...existing, playerId])
    }
  }
  // Host updates its own maps in-place above; broadcastRoster() only
  // emits 'roster-update' locally, not 'player-joined'. Without this
  // emit the host's own menu doesn't lock the joiner's color and the
  // toast surface doesn't fire — so two players could end up picking
  // the same color if the joiner claimed first. Joiners reach the
  // same state via applyRosterSnapshot when the broadcast lands.
  events.emit('player-joined', { peerId: fromPeerId, playerId, isLocal: decision.isLocal })
  broadcastRoster()
}

function hostHandleRelease(fromPeerId: string, playerId: string): void {
  if (!isHost) return
  const decision = decideRelease({
    fromPeerId,
    localPeerId,
    playerId,
    localPlayerIds,
    remotePlayerIdsByPeer,
  })
  if (decision.kind === 'no-op') {
    broadcastRoster()
    return
  }
  if (decision.isLocal) {
    localPlayerIds = localPlayerIds.filter(id => id !== playerId)
  } else {
    const existing = remotePlayerIdsByPeer.get(fromPeerId)
    if (existing) {
      remotePlayerIdsByPeer.set(fromPeerId, existing.filter(id => id !== playerId))
    }
  }
  events.emit('player-left', { peerId: fromPeerId, playerId, isLocal: decision.isLocal })
  broadcastRoster()
}

function applyRosterSnapshot(snap: RosterSnapshot): void {
  // Joiner-side reconcile. Pure diff in src/roster.ts computes the new
  // state + the player-joined/left events; we apply them to the module
  // state and fan out via the local event bus so menu lock state and
  // toast surface catch up.
  const previousRemote = new Map<string, string[]>(remotePlayerIdsByPeer)
  const previousLocal = [...localPlayerIds]
  const diff = diffRosterSnapshot({
    snap,
    previousRemote,
    previousLocal,
    localPeerId,
    isHost,
  })

  remotePlayerIdsByPeer.clear()
  for (const [peerId, ids] of diff.newRemote) remotePlayerIdsByPeer.set(peerId, ids)
  localPlayerIds = diff.newLocal
  if (diff.newHostPeerId) hostPeerIdFromJoinerView = diff.newHostPeerId
  for (const ev of diff.events) {
    events.emit(ev.type, { peerId: ev.peerId, playerId: ev.playerId, isLocal: ev.isLocal })
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

  // Host-side helper: list every joiner the signaling server has told
  // us about, including ones that haven't claimed a color yet. Each
  // entry carries IP and (best-effort reverse-DNS) hostname so the
  // host UI can show who connected even before color picks land.
  getKnownPeers(): PeerInfo[] {
    const out: PeerInfo[] = []
    for (const [peerId, info] of peerInfoByPeer) {
      out.push({ peerId, address: info.address, hostname: info.hostname })
    }
    return out
  },

  // Look up the player ids claimed by a given peer. Useful next to
  // getKnownPeers when rendering "joiner X has claimed (red, blue)".
  getPlayerIdsForPeer(peerId: string): string[] {
    return [...(remotePlayerIdsByPeer.get(peerId) ?? [])]
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
          peerInfoByPeer.set(data.peerId, {
            address: typeof data.address === 'string' ? data.address : null,
            hostname: typeof data.hostname === 'string' ? data.hostname : null,
          })
          // Surface the connection itself even when the joiner hasn't
          // claimed any colors yet. Menu uses this to render the
          // joined-peers list under the room code.
          events.emit('peer-online', {
            peerId: data.peerId,
            address: typeof data.address === 'string' ? data.address : null,
            hostname: typeof data.hostname === 'string' ? data.hostname : null,
          })
          for (const playerId of playerIds) {
            events.emit('player-joined', { peerId: data.peerId, playerId, isLocal: false })
          }
          broadcastRoster()
        } else if (data.type === 'peer-left') {
          const departedPlayerIds = remotePlayerIdsByPeer.get(data.peerId) ?? []
          remotePlayerIdsByPeer.delete(data.peerId)
          peerInfoByPeer.delete(data.peerId)
          events.emit('peer-offline', { peerId: data.peerId })
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
          const existingPeers = Array.isArray(data.peers) ? data.peers : []
          for (const p of existingPeers) {
            if (!p || typeof p.peerId !== 'string' || p.peerId === localPeerId) continue
            const playerIds = normalizePlayerIds(p.playerIds)
            remotePlayerIdsByPeer.set(p.peerId, playerIds)
            for (const playerId of playerIds) {
              events.emit('player-joined', { peerId: p.peerId, playerId, isLocal: false })
            }
          }

          await initiateConnection(data.hostId, ws)
          for (const p of existingPeers) {
            if (!p || typeof p.peerId !== 'string' || p.peerId === localPeerId) continue
            await initiateConnection(p.peerId, ws)
          }
          resolve()
        } else if (data.type === 'host-gone') {
          // Server explicitly tells us the host left. Distinct from a
          // plain WebSocket close (which the server also emits when a
          // room idles out, well before the host has actually gone).
          // UI listeners that need to bail to the menu subscribe to
          // 'host-gone' specifically; 'connection-state' = 'closed' is
          // not a reliable signal during a long live round.
          for (const ids of remotePlayerIdsByPeer.values()) {
            for (const playerId of ids) {
              events.emit('player-left', { peerId: '', playerId, isLocal: false })
            }
          }
          remotePlayerIdsByPeer.clear()
          events.emit('host-gone')
          setConnState('closed')
        } else if (data.type === 'answer') {
          const slot = peers.get(data.from)
          if (slot) await slot.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
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

  // Tear down the local participation in a room. Host: closes the
  // signaling socket (server fans out 'host-gone' to every joiner) and
  // every peer connection. Joiner: closes signaling (server fans out
  // 'peer-left' to host) and every peer connection. Idempotent — safe
  // to call when not in a room.
  leaveRoom(): void {
    for (const slot of peers.values()) {
      try { slot.control?.close() } catch { /* */ }
      try { slot.input?.close() } catch { /* */ }
      try { slot.pc.close() } catch { /* */ }
    }
    peers.clear()
    if (signalingSocket && signalingSocket.readyState <= 1) {
      try { signalingSocket.close() } catch { /* */ }
    }
    signalingSocket = null
    isHost = false
    roomCode = null
    localPeerId = ''
    localPlayerIds = []
    remotePlayerIdsByPeer.clear()
    peerInfoByPeer.clear()
    hostPeerIdFromJoinerView = null
    inputBuffer = new InputBuffer()
    netProvider = null
    hashCompare.clear()
    setConnState('idle')
  },

  // ≥2 players combined (local + remote) is required to start a round.
  // UI uses this to enable/disable the Start Game button.
  canStartRound(): boolean {
    return canStartAuthoritativeRound()
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
    if (!canStartAuthoritativeRound()) throw new Error('network peers are not ready')
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
    const inputRedundancy = (netCfg.inputRedundancyFrames ?? 4) | 0
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
    netProvider = new NetInputProvider(inputBuffer, inputDelay, inputRedundancy, broadcastInputViaNet)
    setInputProvider(netProvider)
    broadcast('control', encodeStart({
      seed,
      arenaWidth,
      arenaHeight,
      startFrame,
      inputDelayFrames: inputDelay,
      stateHashIntervalFrames: hashInterval,
      fps,
      holeInterval,
      holeIntervalRandomness: holeRandom,
      initialSuperpowerCount: initialSp,
      allowedPlayerMask: allowedMask,
      inputRedundancyFrames: inputRedundancy,
    }))
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

  broadcastHostState(snapshot: HostStateSnapshot): void {
    if (!isHost) return
    broadcast('input', encodeJsonMsg(MSG_HOST_STATE, snapshot))
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
    // StateHashCompare resolves any pending remote hash for the same
    // frame now that we have a value to compare against.
    const event = hashCompare.reportLocal(frameId, hash)
    if (event) events.emit('state-hash-mismatch', event.frameId, event.expected, event.actual)
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
  if (peers.has(remotePeerId)) return
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
  if (peers.has(remotePeerId)) return
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
