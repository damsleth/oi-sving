// Tests for the lockstep input buffer. The properties to verify are
// the determinism-preserving ones: out-of-order packet arrival must
// NOT change which fallback bits get returned, future-frame inputs
// must NOT contribute to earlier missing frames, and prune must keep
// a sentinel so the held-key fallback survives the cleanup window.

import { describe, expect, test } from 'bun:test'
import { InputBuffer } from '../src/input-buffer'

const LEFT = 1
const RIGHT = 2
const SUPERPOWER = 4

describe('InputBuffer', () => {
  test('exact (frame, player) read returns the bits that were set', () => {
    const buf = new InputBuffer()
    buf.set(10, 'red', LEFT)
    expect(buf.get(10, 'red')).toBe(LEFT)
  })

  test('returns 0 when the player has never been seen', () => {
    const buf = new InputBuffer()
    expect(buf.get(0, 'red')).toBe(0)
    expect(buf.get(99, 'green')).toBe(0)
  })

  test('fallback returns the latest known frame ≤ requested', () => {
    // Two known frames, asking for one in between. The fallback must
    // pick the older frame (50) because 100 is in the future relative
    // to the requested frame 75.
    const buf = new InputBuffer()
    buf.set(100, 'red', RIGHT)
    buf.set(50, 'red', LEFT)
    expect(buf.get(75, 'red')).toBe(LEFT)
  })

  test('future-frame input does NOT leak into earlier missing frames', () => {
    // Critical determinism property. Frame 102 arrives before frame 100.
    // get(100) must return 0 (no known frame ≤ 100) — NOT 102's bits.
    // Otherwise an out-of-order packet could retroactively change an
    // earlier frame's input on whichever peer received it first.
    const buf = new InputBuffer()
    buf.set(102, 'red', RIGHT)
    expect(buf.get(100, 'red')).toBe(0)
    // Once frame 98 arrives, get(100) reflects it.
    buf.set(98, 'red', LEFT)
    expect(buf.get(100, 'red')).toBe(LEFT)
    // get past 102 still gets the latest (102).
    expect(buf.get(150, 'red')).toBe(RIGHT)
  })

  test('asking for a frame above the latest returns the latest', () => {
    const buf = new InputBuffer()
    buf.set(50, 'red', LEFT)
    buf.set(100, 'red', RIGHT)
    expect(buf.get(200, 'red')).toBe(RIGHT)
  })

  test('two peers receiving packets in different orders agree on every frame', () => {
    // The whole point of the frame-bounded fallback is that two peers
    // can receive the same packets in different orders and still
    // resolve identical answers for any frame.
    const arrivals = [
      { frame: 30, bits: LEFT },
      { frame: 60, bits: RIGHT },
      { frame: 45, bits: LEFT | RIGHT },
      { frame: 90, bits: SUPERPOWER },
      { frame: 75, bits: 0 },
    ]

    const peerA = new InputBuffer()
    for (const a of arrivals) peerA.set(a.frame, 'blue', a.bits)
    const peerB = new InputBuffer()
    for (const a of [...arrivals].reverse()) peerB.set(a.frame, 'blue', a.bits)
    const peerC = new InputBuffer()
    for (const a of [arrivals[3], arrivals[1], arrivals[4], arrivals[0], arrivals[2]]) {
      peerC.set(a.frame, 'blue', a.bits)
    }

    // Sample every frame across the range — each peer must agree.
    for (let f = 0; f <= 120; f++) {
      const a = peerA.get(f, 'blue')
      expect(peerB.get(f, 'blue')).toBe(a)
      expect(peerC.get(f, 'blue')).toBe(a)
    }
  })

  test('exact bits override fallback even when frame is older than the latest', () => {
    const buf = new InputBuffer()
    buf.set(100, 'red', RIGHT)
    buf.set(50, 'red', LEFT)
    expect(buf.get(50, 'red')).toBe(LEFT)
    expect(buf.get(100, 'red')).toBe(RIGHT)
  })

  test('per-player isolation', () => {
    const buf = new InputBuffer()
    buf.set(10, 'red', LEFT)
    buf.set(10, 'blue', RIGHT)
    expect(buf.get(10, 'red')).toBe(LEFT)
    expect(buf.get(10, 'blue')).toBe(RIGHT)
    expect(buf.get(99, 'red')).toBe(LEFT)
    expect(buf.get(99, 'blue')).toBe(RIGHT)
    expect(buf.get(99, 'green')).toBe(0)
  })

  test('redundant set is idempotent', () => {
    const buf = new InputBuffer()
    buf.set(42, 'red', LEFT)
    buf.set(42, 'red', LEFT)
    buf.set(42, 'red', LEFT)
    expect(buf.get(42, 'red')).toBe(LEFT)
  })

  test('a later set with different bits overwrites for the same (frame, player)', () => {
    const buf = new InputBuffer()
    buf.set(42, 'red', LEFT)
    buf.set(42, 'red', RIGHT)
    expect(buf.get(42, 'red')).toBe(RIGHT)
  })

  test('prune drops only frames strictly older than keepFromFrame', () => {
    const buf = new InputBuffer()
    buf.set(10, 'red', LEFT)
    buf.set(20, 'red', RIGHT)
    buf.set(30, 'red', SUPERPOWER)
    buf.prune(20)
    expect(buf.get(20, 'red')).toBe(RIGHT)
    expect(buf.get(30, 'red')).toBe(SUPERPOWER)
  })

  test('prune folds older frames into a single sentinel for held-key fallback', () => {
    // After pruning, the buffer must still know what bits were held
    // immediately before the kept window so future frames that fall
    // between the sentinel and the next exact frame still resolve
    // correctly.
    const buf = new InputBuffer()
    buf.set(10, 'red', LEFT)
    buf.set(20, 'red', RIGHT)
    buf.set(30, 'red', SUPERPOWER)
    buf.set(60, 'red', LEFT)
    buf.prune(50)
    // Sentinel collapses 10/20/30 into the most-recent (30, SUPERPOWER)
    // so a query for frame 55 still resolves to SUPERPOWER, not 0.
    expect(buf.get(55, 'red')).toBe(SUPERPOWER)
    // Future fallback past frame 60 still returns 60's bits.
    expect(buf.get(999, 'red')).toBe(LEFT)
  })

  test('prune preserves cross-peer agreement', () => {
    // Same packet set, different arrival orders, same prune. After the
    // prune, both peers must still answer identically for any frame ≥
    // the prune cutoff.
    const arrivals = [
      { frame: 10, bits: LEFT },
      { frame: 20, bits: RIGHT },
      { frame: 30, bits: SUPERPOWER },
      { frame: 60, bits: 0 },
      { frame: 50, bits: LEFT },
    ]
    const peerA = new InputBuffer()
    for (const a of arrivals) peerA.set(a.frame, 'blue', a.bits)
    peerA.prune(40)

    const peerB = new InputBuffer()
    for (const a of [...arrivals].reverse()) peerB.set(a.frame, 'blue', a.bits)
    peerB.prune(40)

    for (let f = 40; f <= 120; f++) {
      expect(peerB.get(f, 'blue')).toBe(peerA.get(f, 'blue'))
    }
  })
})
