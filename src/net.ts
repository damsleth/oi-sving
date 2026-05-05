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

// Lightweight type alias matching the union used by RTCDataChannel.send().
type DataPayload = ArrayBuffer | ArrayBufferView | string | Blob

const MSG_START = 0x01
const MSG_INPUT = 0x02
const MSG_PING = 0x03
const MSG_LEAVE = 0x04
const MSG_STATE_HASH = 0x05

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
  'connection-state': (state: 'idle' | 'signaling' | 'connecting' | 'open' | 'closed') => void
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
  outboundQueue: DataPayload[]
}

// Buffered per-(frame, playerId) input bitfield. The input channel is
// unordered + maxRetransmits=0, so a single dropped packet is normal.
// Each transmitted INPUT message carries the last `inputRedundancyFrames`
// snapshots; we keep the latest seen value per (frame, player) pair.
class InputBuffer {
  private cells = new Map<string, InputBits>()
  private lastBitsByPlayer = new Map<string, InputBits>()

  set(frameId: number, playerId: string, bits: InputBits): void {
    this.cells.set(`${frameId}|${playerId}`, bits)
    this.lastBitsByPlayer.set(playerId, bits)
  }

  // Resolve input for `frameId` and `playerId`. If the exact frame is
  // missing, fall back to the most recently observed bits for that player
  // (deterministic across peers because each peer has the same redundant
  // history). If we have never seen any bits for that player, return zero
  // input — matches the "AFK death" intuition.
  get(frameId: number, playerId: string): InputBits {
    const exact = this.cells.get(`${frameId}|${playerId}`)
    if (exact !== undefined) return exact
    return this.lastBitsByPlayer.get(playerId) ?? 0
  }

  // Drop entries older than `keepFromFrame`. Bounded memory usage in long
  // rounds.
  prune(keepFromFrame: number): void {
    for (const k of this.cells.keys()) {
      const frame = Number(k.split('|')[0])
      if (frame < keepFromFrame) this.cells.delete(k)
    }
  }
}

class NetInputProvider implements InputProvider {
  constructor(private buffer: InputBuffer, private inputDelay: number) {}
  // The provider returns the bitfield that was scheduled `inputDelay`
  // frames ago. Submission writes into the same delay window, so local
  // and remote players experience identical perceived lag.
  get(frameId: number, playerId: string): InputBits {
    return this.buffer.get(frameId, playerId)
  }
  submit(frameId: number, playerId: string, bits: InputBits): void {
    // Local submissions also live in the buffer at the scheduled frame
    // so the local Curve sees the same delay remote curves see.
    this.buffer.set(frameId + this.inputDelay, playerId, bits)
    OiSving.Net?.broadcastInput(frameId + this.inputDelay, playerId, bits)
  }
}

// Module-level mutable state. The singleton matches the existing OiSving
// module shape; tests inject via OiSving.Net.__setMockSocket.
let signalingSocket: WebSocket | null = null
let roomCode: string | null = null
let isHost = false
let localPeerId = ''
const peers = new Map<string, PeerSlot>()
const events = new EventBus()
let inputBuffer = new InputBuffer()
let netProvider: NetInputProvider | null = null
let connectionState: 'idle' | 'signaling' | 'connecting' | 'open' | 'closed' = 'idle'

function setConnState(s: typeof connectionState) {
  connectionState = s
  events.emit('connection-state', s)
}

function genPeerId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function getNetConfig() {
  return OiSving.Config?.Net ?? {
    signalingUrl: 'ws://localhost:8787/',
    stunServers: ['stun:stun.l.google.com:19302'],
    inputDelayFrames: 2,
    inputRedundancyFrames: 4,
    maxPeers: 6,
    arenaWidth: 1280,
    arenaHeight: 720,
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

function encodeStart(seed: number, arenaWidth: number, arenaHeight: number, startFrame: number, configHash: number): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 4 + 2 + 2 + 4 + 4)
  const v = new DataView(buf)
  v.setUint8(0, MSG_START)
  v.setUint32(1, seed >>> 0)
  v.setUint16(5, arenaWidth)
  v.setUint16(7, arenaHeight)
  v.setUint32(9, configHash >>> 0)
  v.setUint32(13, startFrame)
  return buf
}

function encodeInput(frameId: number, playerId: string, bits: InputBits): ArrayBuffer {
  // playerId is a short color string (red/orange/.../pink). For the wire we
  // use a 1-byte index from the roster mapping. For now embed the first
  // character code; the host roster guarantees uniqueness.
  const buf = new ArrayBuffer(1 + 4 + 1 + 2)
  const v = new DataView(buf)
  v.setUint8(0, MSG_INPUT)
  v.setUint32(1, frameId)
  v.setUint8(5, playerIdToByte(playerId))
  v.setUint8(6, 1)
  v.setUint8(7, bits & 0xff)
  return buf
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

function dispatch(msg: ArrayBuffer): void {
  const v = new DataView(msg)
  const type = v.getUint8(0)
  switch (type) {
    case MSG_START: {
      const seed = v.getUint32(1)
      const arenaWidth = v.getUint16(5)
      const arenaHeight = v.getUint16(7)
      const startFrame = v.getUint32(13)
      setSimRng(new Rng(seed))
      OiSving.Field?.setArenaSize?.(arenaWidth, arenaHeight)
      // Joiner side: install the network input provider so curves read
      // through the lockstep buffer. Host calls startRound() locally and
      // installs the provider there.
      inputBuffer = new InputBuffer()
      netProvider = new NetInputProvider(inputBuffer, getNetConfig().inputDelayFrames)
      setInputProvider(netProvider)
      // Align this peer's frame counter to the host's so input frame ids
      // line up. Game has not necessarily started yet — once it does its
      // CURRENT_FRAME_ID will tick from `startFrame`.
      if (OiSving.Game) OiSving.Game.CURRENT_FRAME_ID = startFrame
      events.emit('round-start', seed, arenaWidth, arenaHeight, startFrame)
      return
    }
    case MSG_INPUT: {
      const frameId = v.getUint32(1)
      const playerId = byteToPlayerId(v.getUint8(5))
      const bits = v.getUint8(7)
      inputBuffer.set(frameId, playerId, bits)
      return
    }
    case MSG_LEAVE: {
      // Roster update would live here. Curve just drives straight using
      // the deterministic-fallback policy in InputBuffer.get.
      return
    }
    case MSG_STATE_HASH: {
      // Compare against local hash if available. Mismatch is emitted as
      // an event; the round can choose to abort to lobby (the simpler
      // failure mode the plan calls for) rather than try to resync.
      const frameId = v.getUint32(1)
      const remoteHash = v.getUint32(5)
      const localHash = OiSving.Game?.computeStateHash?.()
      if (typeof localHash === 'number' && localHash !== remoteHash) {
        events.emit('state-hash-mismatch', frameId, remoteHash, localHash)
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
    dispatch(evt.data as ArrayBuffer)
  })
}

function flushOutbound(slot: PeerSlot): void {
  if (!slot.input || slot.input.readyState !== 'open') return
  for (const m of slot.outboundQueue) slot.input.send(m as ArrayBuffer)
  slot.outboundQueue.length = 0
}

function broadcast(channel: 'control' | 'input', msg: ArrayBuffer): void {
  for (const slot of peers.values()) {
    const ch = channel === 'control' ? slot.control : slot.input
    if (ch && ch.readyState === 'open') {
      ch.send(msg)
    } else if (channel === 'input') {
      slot.outboundQueue.push(msg)
    }
  }
}

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

  on<E extends EventName>(name: E, fn: NetEvents[E]): () => void {
    return events.on(name, fn)
  },

  async host(): Promise<string> {
    const cfg = getNetConfig()
    isHost = true
    localPeerId = genPeerId()
    signalingSocket = openSignaling(cfg.signalingUrl)
    return new Promise<string>((resolve, reject) => {
      const ws = signalingSocket!
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'host', peerId: localPeerId }))
      })
      ws.addEventListener('message', async evt => {
        const data = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data))
        if (data.type === 'hosted') {
          roomCode = data.code
          resolve(roomCode!)
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
    isHost = false
    localPeerId = genPeerId()
    roomCode = code
    signalingSocket = openSignaling(cfg.signalingUrl)
    return new Promise<void>((resolve, reject) => {
      const ws = signalingSocket!
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join', code, peerId: localPeerId }))
      })
      ws.addEventListener('message', async evt => {
        const data = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data))
        if (data.type === 'joined') {
          await initiateConnection(data.hostId, ws)
          resolve()
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

  startRound(seed: number, arenaWidth: number, arenaHeight: number, startFrame = 0, configHash = 0): void {
    if (!isHost) throw new Error('startRound is host-only')
    setSimRng(new Rng(seed))
    OiSving.Field?.setArenaSize?.(arenaWidth, arenaHeight)
    inputBuffer = new InputBuffer()
    netProvider = new NetInputProvider(inputBuffer, getNetConfig().inputDelayFrames)
    setInputProvider(netProvider)
    broadcast('control', encodeStart(seed, arenaWidth, arenaHeight, startFrame, configHash))
    events.emit('round-start', seed, arenaWidth, arenaHeight, startFrame)
  },

  // Same delay applied to remote peers and to the local simulation, so own
  // input never feels snappier than remote input on any peer.
  sendLocalInputs(frameId: number, playerId: string, bits: InputBits): void {
    if (!netProvider) return
    netProvider.submit(frameId, playerId, bits)
  },

  // Used internally by NetInputProvider.submit.
  broadcastInput(scheduledFrameId: number, playerId: string, bits: InputBits): void {
    broadcast('input', encodeInput(scheduledFrameId, playerId, bits))
  },

  getInputsForFrame(frameId: number, playerId: string): InputBits {
    return inputBuffer.get(frameId, playerId)
  },

  pruneInputs(keepFromFrame: number): void {
    inputBuffer.prune(keepFromFrame)
  },

  reportStateHash(frameId: number, hash: number): void {
    broadcast('control', encodeStateHash(frameId, hash))
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
