import { describe, expect, test } from 'bun:test'
import { Rng, getSimRng, setSimRng } from '../src/rng'

describe('Rng', () => {
  test('reproduces the same sequence for the same seed', () => {
    const a = new Rng(0xdeadbeef)
    const b = new Rng(0xdeadbeef)
    for (let i = 0; i < 1024; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  test('next() output is in [0, 1)', () => {
    const r = new Rng(42)
    for (let i = 0; i < 4096; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  test('range(lo, hi) bounds', () => {
    const r = new Rng(1)
    for (let i = 0; i < 1024; i++) {
      const v = r.range(-10, 10)
      expect(v).toBeGreaterThanOrEqual(-10)
      expect(v).toBeLessThan(10)
    }
  })

  test('rangeInt(lo, hi) inclusive', () => {
    const r = new Rng(7)
    const seen = new Set<number>()
    for (let i = 0; i < 4096; i++) {
      const v = r.rangeInt(0, 5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(5)
      seen.add(v)
    }
    // Every bucket should appear in 4096 draws.
    expect(seen.size).toBe(6)
  })

  test('different seeds diverge', () => {
    const a = new Rng(1)
    const b = new Rng(2)
    let same = 0
    for (let i = 0; i < 64; i++) {
      if (a.next() === b.next()) same++
    }
    expect(same).toBeLessThan(8)
  })
})

describe('setSimRng / getSimRng', () => {
  test('replacing the simulation RNG affects subsequent draws', () => {
    setSimRng(new Rng(100))
    const before = getSimRng().next()
    setSimRng(new Rng(100))
    const after = getSimRng().next()
    expect(before).toBe(after)
  })
})
