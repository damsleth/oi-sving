// Pure helpers for the multiplayer wire protocol. Extracted from net.ts so
// they can be unit-tested without dragging the WebRTC + signaling + OiSving
// namespace side-effects of net.ts into the test runtime.
//
// This file knows nothing about runtime state (no peers map, no event bus,
// no current frame id). Encode/decode/round-trip is the contract; net.ts
// composes these with its module-level state.

import type { InputBits } from './input-provider'

// ---------------------------------------------------------------------------
// Message type ids. Kept in one place so the wire-format docs and the
// dispatch site can refer to the same constants.
// ---------------------------------------------------------------------------

export const MSG_START = 0x01
export const MSG_INPUT = 0x02
// MSG_PING reserved (0x03)
export const MSG_LEAVE = 0x04
export const MSG_STATE_HASH = 0x05
export const MSG_PAUSE = 0x06
export const MSG_UNPAUSE = 0x07
export const MSG_ROSTER = 0x08
export const MSG_CLAIM = 0x09
export const MSG_RELEASE = 0x0a
export const MSG_HOST_STATE = 0x0b

// ---------------------------------------------------------------------------
// Player-id <-> byte conversion. PLAYER_ID_TABLE is also the canonical
// allow-list — anything not in the table is rejected at server ingest.
// ---------------------------------------------------------------------------

export const PLAYER_ID_TABLE = ['red', 'orange', 'green', 'blue', 'purple', 'pink'] as const
export type PlayerId = typeof PLAYER_ID_TABLE[number]

export function playerIdToByte(id: string): number {
  const idx = PLAYER_ID_TABLE.indexOf(id as PlayerId)
  return idx >= 0 ? idx : 0xff
}

export function byteToPlayerId(b: number): string {
  return PLAYER_ID_TABLE[b] ?? 'red'
}

export function playerMaskToIds(mask: number): string[] {
  const ids: string[] = []
  for (let i = 0; i < PLAYER_ID_TABLE.length; i++) {
    if (mask & (1 << i)) ids.push(PLAYER_ID_TABLE[i])
  }
  return ids
}

export function playerIdsToMask(ids: string[]): number {
  let mask = 0
  for (const id of ids) {
    const idx = PLAYER_ID_TABLE.indexOf(id as PlayerId)
    if (idx >= 0) mask |= 1 << idx
  }
  return mask
}

// ---------------------------------------------------------------------------
// MSG_START — host-authoritative round-start. Wire layout in docs/protocol.md.
// 23 bytes. Joiners reading a 22-byte legacy packet fall back to redundancy=4.
// ---------------------------------------------------------------------------

export interface StartPacket {
  seed: number
  arenaWidth: number
  arenaHeight: number
  startFrame: number
  inputDelayFrames: number
  stateHashIntervalFrames: number
  fps: number
  holeInterval: number
  holeIntervalRandomness: number
  initialSuperpowerCount: number
  allowedPlayerMask: number
  inputRedundancyFrames: number
}

export function encodeStart(p: StartPacket): ArrayBuffer {
  const buf = new ArrayBuffer(23)
  const v = new DataView(buf)
  v.setUint8(0, MSG_START)
  v.setUint32(1, p.seed >>> 0)
  v.setUint16(5, p.arenaWidth)
  v.setUint16(7, p.arenaHeight)
  v.setUint32(9, p.startFrame)
  v.setUint8(13, p.inputDelayFrames & 0xff)
  v.setUint8(14, p.stateHashIntervalFrames & 0xff)
  v.setUint8(15, p.fps & 0xff)
  v.setUint16(16, p.holeInterval)
  v.setUint16(18, p.holeIntervalRandomness)
  v.setUint8(20, p.initialSuperpowerCount & 0xff)
  v.setUint8(21, p.allowedPlayerMask & 0xff)
  v.setUint8(22, p.inputRedundancyFrames & 0xff)
  return buf
}

export function decodeStart(msg: ArrayBuffer): StartPacket {
  const v = new DataView(msg)
  return {
    seed: v.getUint32(1),
    arenaWidth: v.getUint16(5),
    arenaHeight: v.getUint16(7),
    startFrame: v.getUint32(9),
    inputDelayFrames: v.getUint8(13),
    stateHashIntervalFrames: v.getUint8(14),
    fps: v.getUint8(15),
    holeInterval: v.getUint16(16),
    holeIntervalRandomness: v.getUint16(18),
    initialSuperpowerCount: v.getUint8(20),
    allowedPlayerMask: v.getUint8(21),
    // Length-bounded read for backward compat with pre-2.0.1 hosts that
    // shipped a 22-byte packet without inputRedundancyFrames.
    inputRedundancyFrames: msg.byteLength > 22 ? v.getUint8(22) : 4,
  }
}

// ---------------------------------------------------------------------------
// MSG_INPUT — batched (frameId, bits) entries for one player. Sender packs
// the redundancy window into each packet so a single drop on the unordered
// input channel is repaired by the next packet.
// ---------------------------------------------------------------------------

export interface InputEntry { frameId: number; bits: InputBits }

export function encodeInputBatch(playerId: string, entries: InputEntry[]): ArrayBuffer {
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

export interface InputBatch { playerId: string; entries: InputEntry[] }

export function decodeInputBatch(msg: ArrayBuffer): InputBatch {
  const v = new DataView(msg)
  const playerId = byteToPlayerId(v.getUint8(1))
  const count = v.getUint8(2)
  const entries: InputEntry[] = []
  for (let i = 0; i < count; i++) {
    entries.push({
      frameId: v.getUint32(3 + i * 5),
      bits: v.getUint8(3 + i * 5 + 4),
    })
  }
  return { playerId, entries }
}

// ---------------------------------------------------------------------------
// MSG_STATE_HASH — frame-aligned drift gossip.
// ---------------------------------------------------------------------------

export function encodeStateHash(frameId: number, hash: number): ArrayBuffer {
  const buf = new ArrayBuffer(9)
  const v = new DataView(buf)
  v.setUint8(0, MSG_STATE_HASH)
  v.setUint32(1, frameId)
  v.setUint32(5, hash >>> 0)
  return buf
}

export function decodeStateHash(msg: ArrayBuffer): { frameId: number; hash: number } {
  const v = new DataView(msg)
  return { frameId: v.getUint32(1), hash: v.getUint32(5) }
}

// ---------------------------------------------------------------------------
// MSG_PAUSE / MSG_UNPAUSE — single-byte signals.
// ---------------------------------------------------------------------------

export function encodePause(): ArrayBuffer {
  const buf = new ArrayBuffer(1)
  new DataView(buf).setUint8(0, MSG_PAUSE)
  return buf
}

export function encodeUnpause(): ArrayBuffer {
  const buf = new ArrayBuffer(1)
  new DataView(buf).setUint8(0, MSG_UNPAUSE)
  return buf
}

// ---------------------------------------------------------------------------
// JSON-tagged messages: MSG_ROSTER, MSG_CLAIM, MSG_RELEASE. Type byte +
// UTF-8 JSON. Reliable control channel + low-frequency, so JSON is fine.
// ---------------------------------------------------------------------------

export function encodeJsonMsg(type: number, payload: unknown): ArrayBuffer {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  const buf = new ArrayBuffer(1 + bytes.byteLength)
  new Uint8Array(buf, 0, 1)[0] = type
  new Uint8Array(buf, 1).set(bytes)
  return buf
}

export function decodeJsonMsg(msg: ArrayBuffer): unknown {
  const view = new Uint8Array(msg, 1)
  const json = new TextDecoder().decode(view)
  try { return JSON.parse(json) } catch { return null }
}
