// Tests for the state-hash drift detector. Pin the frame-aligned
// comparison rules — the whole reason for the two-map structure is
// that wall-clock skew makes "compare on receive" a guaranteed false
// positive.

import { describe, expect, test } from 'bun:test'
import { StateHashCompare } from '../src/state-hash-compare'

describe('StateHashCompare', () => {
  test('local-then-matching-remote: no event', () => {
    const c = new StateHashCompare()
    expect(c.reportLocal(60, 0xaaaa)).toBeNull()
    expect(c.reportRemote(60, 0xaaaa)).toBeNull()
  })

  test('local-then-mismatching-remote: emits with remote=expected, local=actual', () => {
    const c = new StateHashCompare()
    expect(c.reportLocal(60, 0xaaaa)).toBeNull()
    const ev = c.reportRemote(60, 0xbbbb)
    expect(ev).toEqual({ frameId: 60, expected: 0xbbbb, actual: 0xaaaa })
  })

  test('remote-then-matching-local: no event, pending entry consumed', () => {
    const c = new StateHashCompare()
    expect(c.reportRemote(60, 0xaaaa)).toBeNull()
    expect(c.reportLocal(60, 0xaaaa)).toBeNull()
    // Pending was consumed: a second local report at the same frame
    // should not see a stale pending entry.
    expect(c.reportLocal(60, 0xaaaa)).toBeNull()
  })

  test('remote-then-mismatching-local: emits once with right shape', () => {
    const c = new StateHashCompare()
    expect(c.reportRemote(60, 0xbbbb)).toBeNull()
    const ev = c.reportLocal(60, 0xaaaa)
    expect(ev).toEqual({ frameId: 60, expected: 0xbbbb, actual: 0xaaaa })
    // Pending consumed: a re-report at the same frame doesn't double-emit.
    expect(c.reportLocal(60, 0xaaaa)).toBeNull()
  })

  test('frames older than retain window are pruned on local report', () => {
    const c = new StateHashCompare(10)
    c.reportLocal(0, 0x1)
    c.reportLocal(5, 0x2)
    // Reporting at frame 100 with retainFrames=10 prunes anything < 90.
    c.reportLocal(100, 0x3)
    // A late remote for frame 0 finds nothing in cache and goes to
    // pending. Note: the pending side only prunes on local reports, so
    // we re-trigger pruning by reporting another local frame after.
    expect(c.reportRemote(0, 0xff)).toBeNull()
  })

  test('multiple frames remembered independently', () => {
    const c = new StateHashCompare()
    c.reportLocal(60, 0xaaaa)
    c.reportLocal(120, 0xbbbb)
    expect(c.reportRemote(60, 0xaaaa)).toBeNull()
    expect(c.reportRemote(120, 0xcccc)).toEqual({ frameId: 120, expected: 0xcccc, actual: 0xbbbb })
  })

  test('clear() drops both maps', () => {
    const c = new StateHashCompare()
    c.reportRemote(60, 0xaaaa)
    c.clear()
    // Local report after clear: no event, because the pending was
    // dropped.
    expect(c.reportLocal(60, 0xbbbb)).toBeNull()
  })
})
