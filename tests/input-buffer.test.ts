// Tests for the lockstep input buffer. The interesting properties to
// verify are the determinism-preserving ones: out-of-order packet
// arrival must NOT change which fallback bits get returned, and prune
// must drop only entries strictly older than the keep-from frame.
//
// These were the source of a real divergence in long-drift testing: a
// previous implementation overwrote lastBitsByPlayer on every set(),
// so two peers receiving the same packets in different orders ended up
// returning different fallback bits for the same frame — guaranteed
// drift even with identical RNG seeds.

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

  test('fallback returns the latest-frame bits, not the latest-arrival bits', () => {
    // Simulating out-of-order WebRTC delivery: frame 100 arrives before
    // frame 50. If the fallback were arrival-ordered, get(200) would
    // return the bits from frame 50 (the most recent arrival). The
    // correct frame-ordered fallback returns the bits from frame 100.
    const buf = new InputBuffer()
    buf.set(100, 'red', RIGHT)
    buf.set(50, 'red', LEFT)
    expect(buf.get(200, 'red')).toBe(RIGHT)
  })

  test('fallback agrees across two peers regardless of arrival order', () => {
    // The whole point of the frame-ordered fallback is that two peers
    // can receive the same packets in different orders and still
    // resolve the same answer for a missing frame.
    const peerA = new InputBuffer()
    const peerB = new InputBuffer()
    const arrivals = [
      { frame: 30, bits: LEFT },
      { frame: 60, bits: RIGHT },
      { frame: 45, bits: LEFT | RIGHT },
      { frame: 90, bits: SUPERPOWER },
      { frame: 75, bits: 0 },
    ]
    // Peer A sees them in given order.
    for (const a of arrivals) peerA.set(a.frame, 'blue', a.bits)
    // Peer B sees them in reverse order.
    for (const a of [...arrivals].reverse()) peerB.set(a.frame, 'blue', a.bits)
    // Peer C sees them in arbitrary shuffle.
    const peerC = new InputBuffer()
    for (const a of [arrivals[3], arrivals[1], arrivals[4], arrivals[0], arrivals[2]]) {
      peerC.set(a.frame, 'blue', a.bits)
    }
    // Fallback for any frame > 90 must be the bits from frame 90 (the
    // latest known frame), regardless of how each peer received them.
    expect(peerA.get(120, 'blue')).toBe(SUPERPOWER)
    expect(peerB.get(120, 'blue')).toBe(SUPERPOWER)
    expect(peerC.get(120, 'blue')).toBe(SUPERPOWER)
  })

  test('exact bits override fallback even when frame is older than the latest', () => {
    const buf = new InputBuffer()
    buf.set(100, 'red', RIGHT)
    buf.set(50, 'red', LEFT)
    // get(50) should return what was set for 50, not the fallback.
    expect(buf.get(50, 'red')).toBe(LEFT)
    // get(100) returns its own bits.
    expect(buf.get(100, 'red')).toBe(RIGHT)
  })

  test('per-player isolation', () => {
    const buf = new InputBuffer()
    buf.set(10, 'red', LEFT)
    buf.set(10, 'blue', RIGHT)
    expect(buf.get(10, 'red')).toBe(LEFT)
    expect(buf.get(10, 'blue')).toBe(RIGHT)
    // Fallbacks per-player.
    expect(buf.get(99, 'red')).toBe(LEFT)
    expect(buf.get(99, 'blue')).toBe(RIGHT)
    expect(buf.get(99, 'green')).toBe(0)
  })

  test('redundant set is idempotent', () => {
    const buf = new InputBuffer()
    buf.set(42, 'red', LEFT)
    buf.set(42, 'red', LEFT) // re-broadcast / packet repeat
    buf.set(42, 'red', LEFT)
    expect(buf.get(42, 'red')).toBe(LEFT)
  })

  test('a later set with different bits overwrites for the same (frame, player)', () => {
    // Should be exceedingly rare in practice (each frame is sampled
    // once), but the contract is last-write-wins.
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
    // Frame 10 is gone — exact lookup yields the fallback (latest-frame, 30 -> SUPERPOWER).
    expect(buf.get(10, 'red')).toBe(SUPERPOWER)
    // Frame 20 retained.
    expect(buf.get(20, 'red')).toBe(RIGHT)
    // Frame 30 retained.
    expect(buf.get(30, 'red')).toBe(SUPERPOWER)
  })

  test('prune does not lose the latest-frame fallback', () => {
    // Pruning must not drop the lastBitsByPlayer state — otherwise a
    // long-running round would lose its fallback once early frames age
    // out and a late-arrival packet for an old frame would suddenly
    // own the fallback again.
    const buf = new InputBuffer()
    buf.set(10, 'red', LEFT)
    buf.set(50, 'red', RIGHT)
    buf.prune(40)
    // Fallback still reflects frame 50.
    expect(buf.get(999, 'red')).toBe(RIGHT)
  })
})
