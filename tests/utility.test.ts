import { beforeAll, describe, expect, test } from 'bun:test'

beforeAll(() => {
  // Minimum DOM/window stubs for utility module side-effects.
  ;(globalThis as Record<string, unknown>).window = {
    PIXI: {},
    OiSving: undefined,
    navigator: { userAgent: 'Bun test runner' },
  }
  ;(globalThis as Record<string, unknown>).document = {
    getElementById: () => null,
  }
  ;(globalThis as Record<string, unknown>).navigator = { userAgent: 'Bun test runner' }
})

describe('OiSving.Utility', () => {
  test('round', async () => {
    const { u } = await import('../src/OiSvingUtility')
    expect(u.round(1.234, 1)).toBe(1.2)
    expect(u.round(1.25, 1)).toBe(1.3)
    expect(u.round(7.4999, 0)).toBe(7)
  })

  test('merge keeps last-write-wins semantics', async () => {
    const { u } = await import('../src/OiSvingUtility')
    const out = u.merge({ a: 1, b: 2 }, { b: 3, c: 4 }, { c: 5 })
    expect(out).toEqual({ a: 1, b: 3, c: 5 })
  })

  test('stringToHex parses #RRGGBB', async () => {
    const { u } = await import('../src/OiSvingUtility')
    expect(u.stringToHex('#FF00AA')).toBe(0xff00aa)
    expect(u.stringToHex('#000000')).toBe(0x000000)
  })

  test('interpolateTwoPoints fills the integer cells along the line', async () => {
    const { u } = await import('../src/OiSvingUtility')
    const map = u.interpolateTwoPoints(0, 0, 4, 0)
    // 4 cells along the X axis, all at y=0
    expect(Object.keys(map).map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    for (const k of Object.keys(map)) {
      expect(map[Number(k)]['0']).toBe(true)
    }
  })
})
