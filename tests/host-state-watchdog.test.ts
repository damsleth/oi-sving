// Tests for the joiner-side host-state staleness watchdog. Drives the
// timer with bun's mock clock so we can assert what fires when, without
// real wall-clock waits.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { HostStateWatchdog, type WatchdogEvent } from '../src/host-state-watchdog'

describe('HostStateWatchdog', () => {
  let originalSetTimeout: typeof setTimeout
  let originalClearTimeout: typeof clearTimeout
  let pendingTimers: Array<{ id: number; cb: () => void; due: number }>
  let nextId: number
  let now: number

  beforeEach(() => {
    pendingTimers = []
    nextId = 1
    now = 1_000_000
    originalSetTimeout = globalThis.setTimeout
    originalClearTimeout = globalThis.clearTimeout
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.setTimeout = ((cb: () => void, delay: number) => {
      const id = nextId++
      pendingTimers.push({ id, cb, due: now + delay })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.clearTimeout = ((id: number) => {
      pendingTimers = pendingTimers.filter(t => t.id !== id)
    }) as any
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })

  function advance(ms: number): void {
    now += ms
    const due = pendingTimers.filter(t => t.due <= now)
    pendingTimers = pendingTimers.filter(t => t.due > now)
    for (const t of due) t.cb()
  }

  test('fires host-state-stalled after stallMs of silence', () => {
    const events: WatchdogEvent[] = []
    const w = new HostStateWatchdog({ stallMs: 2000, evictionWindowMs: 5000, evictionThreshold: 3, now: () => now })
    w.setListener(e => events.push(e))
    w.start()
    advance(1999)
    expect(events).toEqual([])
    advance(1)
    expect(events.map(e => e.kind)).toEqual(['host-state-stalled'])
  })

  test('noteHostStateApplied resets the stall timer', () => {
    const events: WatchdogEvent[] = []
    const w = new HostStateWatchdog({ stallMs: 2000, evictionWindowMs: 5000, evictionThreshold: 3, now: () => now })
    w.setListener(e => events.push(e))
    w.start()
    advance(1500)
    w.noteHostStateApplied()
    advance(1500)
    // 1500ms since the reset, still under 2000ms threshold.
    expect(events).toEqual([])
    advance(500)
    expect(events.map(e => e.kind)).toEqual(['host-state-stalled'])
  })

  test('three stalls inside the eviction window fire peer-desync', () => {
    const events: WatchdogEvent[] = []
    const w = new HostStateWatchdog({ stallMs: 1000, evictionWindowMs: 5000, evictionThreshold: 3, now: () => now })
    w.setListener(e => events.push(e))
    w.start()
    advance(1000)
    advance(1000)
    advance(1000)
    expect(events.map(e => e.kind)).toEqual([
      'host-state-stalled',
      'host-state-stalled',
      'host-state-stalled',
      'peer-desync',
    ])
  })

  test('stalls outside the eviction window are pruned from the count', () => {
    // Pump 2 stalls inside the window, then keep the watchdog fed long
    // enough that those stalls age out of the 5s eviction window.
    // Two more stalls after the gap should land alone in the window
    // (count 2, threshold 3) and NOT trigger peer-desync.
    const events: WatchdogEvent[] = []
    const w = new HostStateWatchdog({ stallMs: 1000, evictionWindowMs: 5000, evictionThreshold: 3, now: () => now })
    w.setListener(e => events.push(e))
    w.start()
    advance(1000)
    advance(1000)
    // 2 stalls in window so far, no peer-desync.
    expect(events.filter(e => e.kind === 'peer-desync')).toEqual([])
    // Recover: tick noteHostStateApplied every 500ms for 6 seconds so
    // the watchdog never crosses stallMs again. now advances past the
    // 5s eviction window.
    for (let i = 0; i < 12; i++) {
      now += 500
      w.noteHostStateApplied()
    }
    // Now 2 fresh stalls. Earlier 2 should have aged out.
    advance(1000)
    advance(1000)
    expect(events.filter(e => e.kind === 'peer-desync')).toEqual([])
    expect(events.filter(e => e.kind === 'host-state-stalled').length).toBe(4)
  })

  test('stop() halts the timer chain', () => {
    const events: WatchdogEvent[] = []
    const w = new HostStateWatchdog({ stallMs: 1000, now: () => now })
    w.setListener(e => events.push(e))
    w.start()
    advance(500)
    w.stop()
    advance(10_000)
    expect(events).toEqual([])
  })
})
