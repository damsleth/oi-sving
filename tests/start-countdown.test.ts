// The first-start countdown must yield exactly one round start no matter
// how a manual start (space, start button, joiner start-request) races it.

import { describe, expect, test } from 'bun:test'
import { StartCountdown } from '../src/start-countdown'

function fakeTimers() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { cb: () => void; due: number }>()
  return {
    timers: {
      setTimeout: (cb: () => void, ms: number) => {
        const id = nextId++
        pending.set(id, { cb, due: now + ms })
        return id
      },
      clearTimeout: (id: number) => {
        pending.delete(id)
      },
    },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0]
        if (!next || next[1].due > end) break
        pending.delete(next[0])
        now = next[1].due
        next[1].cb()
      }
      now = end
    },
    count: () => pending.size,
  }
}

// Mirrors how Menu/Game wire it: any round start cancels the countdown,
// and the countdown completion only starts if no round is running yet.
function harness() {
  const clock = fakeTimers()
  const cd = new StartCountdown(clock.timers)
  let starts = 0
  const ticks: number[] = []
  const startRound = () => {
    cd.cancel()
    starts++
  }
  const begin = () =>
    cd.start(5, {
      onTick: (n) => ticks.push(n),
      onDone: () => {
        if (starts === 0) startRound()
      },
    })
  return { clock, cd, ticks, begin, startRound, starts: () => starts }
}

describe('StartCountdown', () => {
  test('completing the countdown starts exactly once', () => {
    const h = harness()
    h.begin()
    h.clock.advance(10_000)
    expect(h.ticks).toEqual([5, 4, 3, 2, 1])
    expect(h.starts()).toBe(1)
    expect(h.cd.isPending()).toBe(false)
  })

  test('manual start during countdown cancels it', () => {
    const h = harness()
    h.begin()
    h.clock.advance(2_000)
    h.startRound()
    expect(h.cd.isPending()).toBe(false)
    expect(h.clock.count()).toBe(0)
    h.clock.advance(10_000)
    expect(h.starts()).toBe(1)
  })

  test('repeated start requests do not stack timers', () => {
    const h = harness()
    expect(h.begin()).toBe(true)
    h.clock.advance(1_000)
    expect(h.begin()).toBe(false)
    expect(h.begin()).toBe(false)
    h.clock.advance(10_000)
    expect(h.starts()).toBe(1)
    expect(h.ticks).toEqual([5, 4, 3, 2, 1])
  })

  test('cancel without a pending countdown is a no-op', () => {
    const h = harness()
    expect(h.cd.cancel()).toBe(false)
  })
})
