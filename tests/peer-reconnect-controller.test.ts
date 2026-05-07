// Tests for the per-peer reconnect controller. Pure state machine over
// RTCPeerConnection.connectionstatechange transitions; verified
// without booting any WebRTC.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  PeerReconnectController,
  type ReconnectDecision,
  type WebRtcConnectionState,
} from '../src/peer-reconnect-controller'

describe('PeerReconnectController', () => {
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

  function makeController(opts: Partial<{
    disconnectDebounceMs: number
    attemptWindowMs: number
    maxAttemptsPerWindow: number
  }> = {}): {
    controller: PeerReconnectController
    decisions: ReconnectDecision[]
  } {
    const decisions: ReconnectDecision[] = []
    const controller = new PeerReconnectController({
      disconnectDebounceMs: opts.disconnectDebounceMs ?? 1000,
      attemptWindowMs: opts.attemptWindowMs ?? 5000,
      maxAttemptsPerWindow: opts.maxAttemptsPerWindow ?? 3,
      now: () => now,
    })
    controller.setListener(d => decisions.push(d))
    return { controller, decisions }
  }

  function pump(controller: PeerReconnectController, states: WebRtcConnectionState[]): void {
    for (const s of states) controller.noteState(s)
  }

  test('disconnect that resolves within debounce does not trigger restart', () => {
    const { controller, decisions } = makeController()
    pump(controller, ['connecting', 'connected', 'disconnected'])
    advance(500)
    pump(controller, ['connected'])
    advance(2000)
    expect(decisions.filter(d => d.kind !== 'idle').map(d => d.kind)).toEqual(['wait-debounce'])
  })

  test('disconnect that persists past debounce triggers restart-ice', () => {
    const { controller, decisions } = makeController()
    pump(controller, ['connecting', 'connected', 'disconnected'])
    advance(1000)
    expect(decisions.filter(d => d.kind !== 'idle').map(d => d.kind)).toEqual(['wait-debounce', 'restart-ice'])
  })

  test('failed state skips debounce and restarts immediately', () => {
    const { controller, decisions } = makeController()
    pump(controller, ['connecting', 'connected', 'failed'])
    expect(decisions.filter(d => d.kind !== 'idle').map(d => d.kind)).toEqual(['restart-ice'])
  })

  test('three restarts inside the attempt window are allowed; the fourth gives up', () => {
    const { controller, decisions } = makeController({ disconnectDebounceMs: 100, attemptWindowMs: 5000, maxAttemptsPerWindow: 3 })
    // Cycle disconnect/failed three times.
    for (let i = 0; i < 3; i++) {
      controller.noteState('connected')
      controller.noteState('failed')
    }
    // Restart-ice fired three times so far. Fourth attempt -> give-up.
    controller.noteState('connected')
    controller.noteState('failed')
    expect(decisions.filter(d => d.kind === 'restart-ice').length).toBe(3)
    expect(decisions.filter(d => d.kind === 'give-up').length).toBe(1)
  })

  test('attempts outside the window are pruned and budget refreshes', () => {
    const { controller, decisions } = makeController({ disconnectDebounceMs: 100, attemptWindowMs: 5000, maxAttemptsPerWindow: 2 })
    controller.noteState('connected')
    controller.noteState('failed') // attempt 1
    controller.noteState('connected')
    controller.noteState('failed') // attempt 2
    // Both attempts are at now=1_000_000. Advance past the window.
    now += 6000
    controller.noteState('connected')
    controller.noteState('failed') // attempt 3, but earlier two evicted -> attempts=[1]
    expect(decisions.filter(d => d.kind === 'restart-ice').length).toBe(3)
    expect(decisions.filter(d => d.kind === 'give-up').length).toBe(0)
  })

  test('connected state cancels a pending debounce', () => {
    const { controller, decisions } = makeController({ disconnectDebounceMs: 1000 })
    pump(controller, ['connecting', 'connected', 'disconnected'])
    advance(500)
    pump(controller, ['connected'])
    // Past the original debounce; the cancel must have fired.
    advance(1000)
    expect(decisions.filter(d => d.kind === 'restart-ice')).toEqual([])
  })

  test('stop() halts pending debounce', () => {
    const { controller, decisions } = makeController()
    pump(controller, ['connected', 'disconnected'])
    controller.stop()
    advance(2000)
    expect(decisions.filter(d => d.kind === 'restart-ice')).toEqual([])
  })
})
