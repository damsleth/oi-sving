// Tests for the lockstep network input provider — specifically the
// per-player redundancy ring it broadcasts. Submitting a frame must:
//   1. write the bits into the local InputBuffer at frameId+inputDelay
//      (so own input feels exactly like remote input);
//   2. append the (frameId+delay, bits) pair to a ring of the last N
//      submissions for that player;
//   3. broadcast the FULL ring on every send so a single drop on the
//      unordered + maxRetransmits=0 input channel is repaired by the
//      next packet.

import { describe, expect, test } from 'bun:test'
import { InputBuffer } from '../src/input-buffer'
import { NetInputProvider, type InputEntry } from '../src/net-input-provider'

interface BroadcastCall { playerId: string; ring: InputEntry[] }

function newProvider(opts: { inputDelay?: number; redundancy?: number } = {}) {
  const buffer = new InputBuffer()
  const calls: BroadcastCall[] = []
  const provider = new NetInputProvider(
    buffer,
    opts.inputDelay ?? 2,
    opts.redundancy ?? 4,
    (playerId, ring) => calls.push({ playerId, ring }),
  )
  return { buffer, calls, provider }
}

describe('NetInputProvider', () => {
  test('writes own input into the buffer at frameId + inputDelay', () => {
    const { buffer, provider } = newProvider({ inputDelay: 2 })
    provider.submit(100, 'red', 0b001)
    expect(buffer.get(100, 'red')).toBe(0)        // not yet at frame 100
    expect(buffer.get(102, 'red')).toBe(0b001)    // scheduled at +delay
  })

  test('inputDelay = 0 means immediate effect', () => {
    const { buffer, provider } = newProvider({ inputDelay: 0 })
    provider.submit(50, 'red', 0b010)
    expect(buffer.get(50, 'red')).toBe(0b010)
  })

  test('first submission broadcasts a single-entry ring', () => {
    const { calls, provider } = newProvider({ inputDelay: 2, redundancy: 4 })
    provider.submit(100, 'red', 0b001)
    expect(calls).toHaveLength(1)
    expect(calls[0].playerId).toBe('red')
    expect(calls[0].ring).toEqual([{ frameId: 102, bits: 0b001 }])
  })

  test('ring grows up to redundancy and then drops the oldest entry', () => {
    const { calls, provider } = newProvider({ inputDelay: 2, redundancy: 3 })
    provider.submit(10, 'red', 1)
    provider.submit(11, 'red', 2)
    provider.submit(12, 'red', 3)
    provider.submit(13, 'red', 4)

    const last = calls[calls.length - 1].ring
    expect(last).toEqual([
      { frameId: 13, bits: 2 }, // 11 + delay 2
      { frameId: 14, bits: 3 },
      { frameId: 15, bits: 4 },
    ])
  })

  test('every broadcast carries the redundancy window, not just the new frame', () => {
    const { calls, provider } = newProvider({ inputDelay: 0, redundancy: 4 })
    for (let f = 0; f < 4; f++) provider.submit(f, 'red', f + 1)
    expect(calls[3].ring).toEqual([
      { frameId: 0, bits: 1 },
      { frameId: 1, bits: 2 },
      { frameId: 2, bits: 3 },
      { frameId: 3, bits: 4 },
    ])
  })

  test('rings are per-player', () => {
    const { calls, provider } = newProvider({ inputDelay: 0, redundancy: 4 })
    provider.submit(10, 'red', 1)
    provider.submit(10, 'blue', 2)
    provider.submit(11, 'red', 3)

    const redLast = [...calls].reverse().find(c => c.playerId === 'red')!.ring
    const blueLast = [...calls].reverse().find(c => c.playerId === 'blue')!.ring
    expect(redLast).toEqual([
      { frameId: 10, bits: 1 },
      { frameId: 11, bits: 3 },
    ])
    expect(blueLast).toEqual([{ frameId: 10, bits: 2 }])
  })

  test('broadcast ring snapshots are independent of subsequent mutations', () => {
    // Tests pulled the ring as `[...ring]` so a recorder holding the
    // reference doesn't see new entries appended later. If broadcastFn
    // were given the live ring instead, subsequent calls would mutate
    // already-captured state.
    const { calls, provider } = newProvider({ inputDelay: 0, redundancy: 4 })
    provider.submit(0, 'red', 1)
    const captured = calls[0].ring
    expect(captured).toHaveLength(1)
    provider.submit(1, 'red', 2)
    expect(captured).toHaveLength(1) // still as it was when we captured it
  })

  test('default redundancy is 4 when not specified', () => {
    const buffer = new InputBuffer()
    const calls: BroadcastCall[] = []
    const provider = new NetInputProvider(
      buffer,
      0,
      undefined as unknown as number,
      (playerId, ring) => calls.push({ playerId, ring }),
    )
    for (let f = 0; f < 6; f++) provider.submit(f, 'red', f)
    expect(calls[calls.length - 1].ring).toHaveLength(4)
  })

  test('default broadcastFn is a safe no-op so tests can construct without a network', () => {
    const buffer = new InputBuffer()
    const provider = new NetInputProvider(buffer, 0, 4)
    expect(() => provider.submit(0, 'red', 1)).not.toThrow()
    // Buffer still receives the local schedule even without a broadcast.
    expect(buffer.get(0, 'red')).toBe(1)
  })

  test('get() reads through to the underlying buffer', () => {
    const { buffer, provider } = newProvider({ inputDelay: 0 })
    buffer.set(50, 'red', 0b100)
    expect(provider.get(50, 'red')).toBe(0b100)
    expect(provider.get(99, 'red')).toBe(0b100) // frame-bounded fallback
    expect(provider.get(50, 'blue')).toBe(0)
  })
})
