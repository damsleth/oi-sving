// Sliding-window mismatch tracker. Pure state machine - no WebRTC, no
// network. Verifies the per-peer count, the eviction threshold, and
// the window decay.

import { describe, expect, test } from 'bun:test'
import { HostMismatchTracker } from '../src/host-mismatch-tracker'

describe('HostMismatchTracker', () => {
  test('first mismatch returns resync', () => {
    let now = 1_000_000
    const t = new HostMismatchTracker({ now: () => now })
    expect(t.noteMismatch('peerA')).toEqual({ kind: 'resync' })
    expect(t.countWithinWindow('peerA')).toBe(1)
  })

  test('two mismatches inside the window: still resync', () => {
    let now = 1_000_000
    const t = new HostMismatchTracker({ windowMs: 5000, maxMismatches: 3, now: () => now })
    t.noteMismatch('peerA')
    now += 1000
    expect(t.noteMismatch('peerA')).toEqual({ kind: 'resync' })
  })

  test('third mismatch inside the window: evict', () => {
    let now = 1_000_000
    const t = new HostMismatchTracker({ windowMs: 5000, maxMismatches: 3, now: () => now })
    t.noteMismatch('peerA')
    now += 1000
    t.noteMismatch('peerA')
    now += 1000
    expect(t.noteMismatch('peerA')).toEqual({ kind: 'evict' })
  })

  test('mismatches falling outside the window do not count', () => {
    let now = 1_000_000
    const t = new HostMismatchTracker({ windowMs: 5000, maxMismatches: 3, now: () => now })
    t.noteMismatch('peerA')
    now += 4000
    t.noteMismatch('peerA')
    now += 4000  // first mismatch now ~8s old, evicted from window
    expect(t.noteMismatch('peerA')).toEqual({ kind: 'resync' })
    expect(t.countWithinWindow('peerA')).toBe(2)
  })

  test('two peers tracked independently', () => {
    let now = 1_000_000
    const t = new HostMismatchTracker({ windowMs: 5000, maxMismatches: 3, now: () => now })
    t.noteMismatch('peerA')
    t.noteMismatch('peerA')
    expect(t.countWithinWindow('peerA')).toBe(2)
    expect(t.noteMismatch('peerB')).toEqual({ kind: 'resync' })
    expect(t.countWithinWindow('peerB')).toBe(1)
    // peerA's third should still evict only peerA
    expect(t.noteMismatch('peerA')).toEqual({ kind: 'evict' })
    expect(t.noteMismatch('peerB')).toEqual({ kind: 'resync' })
  })

  test('forget(peer) drops their history', () => {
    let now = 1_000_000
    const t = new HostMismatchTracker({ windowMs: 5000, maxMismatches: 3, now: () => now })
    t.noteMismatch('peerA')
    t.noteMismatch('peerA')
    t.forget('peerA')
    expect(t.countWithinWindow('peerA')).toBe(0)
    expect(t.noteMismatch('peerA')).toEqual({ kind: 'resync' })
  })

  test('clear() drops every peer', () => {
    let now = 1_000_000
    const t = new HostMismatchTracker({ windowMs: 5000, maxMismatches: 3, now: () => now })
    t.noteMismatch('peerA')
    t.noteMismatch('peerB')
    t.clear()
    expect(t.countWithinWindow('peerA')).toBe(0)
    expect(t.countWithinWindow('peerB')).toBe(0)
  })

  test('default options match the protocol spec (5s window, 3 strikes)', () => {
    let now = 1_000_000
    const t = new HostMismatchTracker({ now: () => now })
    t.noteMismatch('peerA')
    now += 1000
    t.noteMismatch('peerA')
    now += 1000
    expect(t.noteMismatch('peerA')).toEqual({ kind: 'evict' })
  })
})
