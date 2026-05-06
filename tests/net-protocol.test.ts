// Wire-protocol tests. Round-trip every encoder/decoder pair and pin down
// the byte layouts so a future "small refactor" of the wire format can't
// silently break joiners running an older binary. The actual fields and
// offsets are covered in docs/protocol.md.

import { describe, expect, test } from 'bun:test'
import {
  MSG_START,
  MSG_INPUT,
  MSG_STATE_HASH,
  MSG_PAUSE,
  MSG_UNPAUSE,
  MSG_ROSTER,
  MSG_CLAIM,
  MSG_RELEASE,
  PLAYER_ID_TABLE,
  playerIdToByte,
  byteToPlayerId,
  playerMaskToIds,
  playerIdsToMask,
  encodeStart,
  decodeStart,
  encodeInputBatch,
  decodeInputBatch,
  encodeStateHash,
  decodeStateHash,
  encodePause,
  encodeUnpause,
  encodeJsonMsg,
  decodeJsonMsg,
} from '../src/net-protocol'

describe('player id <-> byte', () => {
  test('round-trips every entry in PLAYER_ID_TABLE', () => {
    for (let i = 0; i < PLAYER_ID_TABLE.length; i++) {
      expect(playerIdToByte(PLAYER_ID_TABLE[i])).toBe(i)
      expect(byteToPlayerId(i)).toBe(PLAYER_ID_TABLE[i])
    }
  })

  test('unknown id encodes as 0xff sentinel', () => {
    expect(playerIdToByte('teal')).toBe(0xff)
    expect(playerIdToByte('')).toBe(0xff)
  })

  test('out-of-range byte falls back to red so dispatch never crashes', () => {
    expect(byteToPlayerId(0xff)).toBe('red')
    expect(byteToPlayerId(99)).toBe('red')
  })
})

describe('player mask <-> ids', () => {
  test('full mask round-trips to every player', () => {
    const all = playerMaskToIds(0x3f)
    expect(all).toEqual([...PLAYER_ID_TABLE])
    expect(playerIdsToMask(all)).toBe(0x3f)
  })

  test('zero mask is empty', () => {
    expect(playerMaskToIds(0)).toEqual([])
    expect(playerIdsToMask([])).toBe(0)
  })

  test('individual bits round-trip', () => {
    for (let i = 0; i < PLAYER_ID_TABLE.length; i++) {
      const mask = 1 << i
      const ids = playerMaskToIds(mask)
      expect(ids).toEqual([PLAYER_ID_TABLE[i]])
      expect(playerIdsToMask(ids)).toBe(mask)
    }
  })

  test('subset round-trip preserves canonical ordering, not call-order', () => {
    // Encoded mask is bit-positional, so decode order follows
    // PLAYER_ID_TABLE regardless of how the input ids are arranged.
    const ids = ['blue', 'red', 'pink']
    const mask = playerIdsToMask(ids)
    const decoded = playerMaskToIds(mask)
    expect(decoded).toEqual(['red', 'blue', 'pink'])
  })

  test('unknown ids in input are skipped', () => {
    expect(playerIdsToMask(['red', 'teal', 'blue'])).toBe((1 << 0) | (1 << 3))
  })
})

describe('encodeStart / decodeStart', () => {
  const sample = {
    seed: 0xdeadbeef >>> 0,
    arenaWidth: 1024,
    arenaHeight: 768,
    startFrame: 0,
    inputDelayFrames: 2,
    stateHashIntervalFrames: 60,
    fps: 60,
    holeInterval: 150,
    holeIntervalRandomness: 300,
    initialSuperpowerCount: 2,
    allowedPlayerMask: 0x3f,
    inputRedundancyFrames: 4,
  }

  test('round-trips every field of a typical packet', () => {
    const buf = encodeStart(sample)
    expect(buf.byteLength).toBe(23)
    expect(new DataView(buf).getUint8(0)).toBe(MSG_START)
    const decoded = decodeStart(buf)
    expect(decoded).toEqual(sample)
  })

  test('handles values at the byte-width edges', () => {
    const edge = {
      ...sample,
      seed: 0xffffffff >>> 0,
      arenaWidth: 0xffff,
      arenaHeight: 0xffff,
      startFrame: 0xffffffff,
      inputDelayFrames: 255,
      stateHashIntervalFrames: 255,
      fps: 255,
      holeInterval: 0xffff,
      holeIntervalRandomness: 0xffff,
      initialSuperpowerCount: 255,
      allowedPlayerMask: 0xff,
      inputRedundancyFrames: 255,
    }
    expect(decodeStart(encodeStart(edge))).toEqual(edge)
  })

  test('legacy 22-byte packet decodes redundancy as the default 4', () => {
    // Older host built MSG_START without the redundancy byte. Truncate
    // the encoded packet to 22 bytes and confirm the decoder falls back
    // to redundancy=4 instead of reading uninitialized memory.
    const full = encodeStart(sample)
    const trimmed = full.slice(0, 22)
    expect(trimmed.byteLength).toBe(22)
    const decoded = decodeStart(trimmed)
    expect(decoded.inputRedundancyFrames).toBe(4)
    expect(decoded.seed).toBe(sample.seed)
    expect(decoded.arenaWidth).toBe(sample.arenaWidth)
  })
})

describe('encodeInputBatch / decodeInputBatch', () => {
  test('round-trips a 4-frame redundancy window', () => {
    const entries = [
      { frameId: 100, bits: 0b001 },
      { frameId: 101, bits: 0b011 },
      { frameId: 102, bits: 0b100 },
      { frameId: 103, bits: 0b000 },
    ]
    const buf = encodeInputBatch('red', entries)
    expect(buf.byteLength).toBe(3 + entries.length * 5)
    expect(new DataView(buf).getUint8(0)).toBe(MSG_INPUT)
    expect(new DataView(buf).getUint8(1)).toBe(0) // red index
    expect(new DataView(buf).getUint8(2)).toBe(entries.length)
    expect(decodeInputBatch(buf)).toEqual({ playerId: 'red', entries })
  })

  test('empty entries produce a 3-byte header packet', () => {
    const buf = encodeInputBatch('blue', [])
    expect(buf.byteLength).toBe(3)
    expect(decodeInputBatch(buf)).toEqual({ playerId: 'blue', entries: [] })
  })

  test('preserves entry order on decode', () => {
    const entries = [
      { frameId: 5, bits: 1 },
      { frameId: 10, bits: 2 },
      { frameId: 7, bits: 4 },
    ]
    const decoded = decodeInputBatch(encodeInputBatch('green', entries))
    expect(decoded.entries.map(e => e.frameId)).toEqual([5, 10, 7])
  })
})

describe('encodeStateHash / decodeStateHash', () => {
  test('round-trips frame and hash', () => {
    const buf = encodeStateHash(60, 0x12345678 >>> 0)
    expect(buf.byteLength).toBe(9)
    expect(new DataView(buf).getUint8(0)).toBe(MSG_STATE_HASH)
    expect(decodeStateHash(buf)).toEqual({ frameId: 60, hash: 0x12345678 >>> 0 })
  })

  test('preserves the high bit of the hash', () => {
    // 32-bit unsigned must survive — DataView.getUint32 returns a
    // non-negative number, and the encode side guards with >>> 0.
    const buf = encodeStateHash(60, 0xffffffff >>> 0)
    expect(decodeStateHash(buf).hash).toBe(0xffffffff)
  })
})

describe('encodePause / encodeUnpause', () => {
  test('produces a single byte with the right type tag', () => {
    expect(new DataView(encodePause()).getUint8(0)).toBe(MSG_PAUSE)
    expect(encodePause().byteLength).toBe(1)
    expect(new DataView(encodeUnpause()).getUint8(0)).toBe(MSG_UNPAUSE)
    expect(encodeUnpause().byteLength).toBe(1)
  })
})

describe('encodeJsonMsg / decodeJsonMsg', () => {
  test('round-trips a roster snapshot', () => {
    const snap = {
      hostPeerId: 'h0',
      hostPlayerIds: ['red'],
      joiners: [
        { peerId: 'a', playerIds: ['blue'] },
        { peerId: 'b', playerIds: [] },
      ],
    }
    const buf = encodeJsonMsg(MSG_ROSTER, snap)
    expect(new DataView(buf).getUint8(0)).toBe(MSG_ROSTER)
    expect(decodeJsonMsg(buf)).toEqual(snap)
  })

  test('round-trips a claim payload', () => {
    const buf = encodeJsonMsg(MSG_CLAIM, { playerId: 'red' })
    expect(new DataView(buf).getUint8(0)).toBe(MSG_CLAIM)
    expect(decodeJsonMsg(buf)).toEqual({ playerId: 'red' })
  })

  test('round-trips a release payload', () => {
    const buf = encodeJsonMsg(MSG_RELEASE, { playerId: 'green' })
    expect(new DataView(buf).getUint8(0)).toBe(MSG_RELEASE)
    expect(decodeJsonMsg(buf)).toEqual({ playerId: 'green' })
  })

  test('returns null on a payload that is not valid JSON', () => {
    // Hand-craft a packet whose body is a partial UTF-8 sequence so
    // JSON.parse throws and decodeJsonMsg falls back to null.
    const buf = new ArrayBuffer(3)
    const v = new DataView(buf)
    v.setUint8(0, MSG_ROSTER)
    v.setUint8(1, 0xff)
    v.setUint8(2, 0xfe)
    expect(decodeJsonMsg(buf)).toBeNull()
  })
})
