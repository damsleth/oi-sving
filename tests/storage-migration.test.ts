import { beforeEach, describe, expect, test } from 'bun:test'

// Bun test runs without DOM. Stub a tiny localStorage / sessionStorage so the
// migration helper can be exercised under bun test.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  key(i: number): string | null {
    return [...this.store.keys()][i] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const localMem = new MemoryStorage()
const sessionMem = new MemoryStorage()

;(globalThis as Record<string, unknown>).window = {
  localStorage: localMem,
  sessionStorage: sessionMem,
  PIXI: {},
}

const ns = await import('../src/namespace')
await import('../src/OiSvingStorage')

beforeEach(() => {
  localMem.clear()
  sessionMem.clear()
})

describe('OiSving.Storage.getWithMigration', () => {
  test('returns the new key value when present', () => {
    ns.OiSving.Storage.set('oisving.theme', 'dark')
    expect(ns.OiSving.Storage.getWithMigration('oisving.theme', 'kurve.theme')).toBe('dark')
  })

  test('falls back to the legacy key, copies forward, and removes the old', () => {
    ns.OiSving.Storage.set('kurve.theme', 'default')
    const result = ns.OiSving.Storage.getWithMigration('oisving.theme', 'kurve.theme')
    expect(result).toBe('default')
    expect(ns.OiSving.Storage.has('oisving.theme')).toBe(true)
    expect(ns.OiSving.Storage.has('kurve.theme')).toBe(false)
  })

  test('returns null when neither key is set', () => {
    expect(ns.OiSving.Storage.getWithMigration('oisving.theme', 'kurve.theme')).toBeNull()
  })

  test('respects sessionStorage scope', () => {
    ns.OiSving.Storage.set('kurve.sound.muted', true, 'sessionStorage')
    const result = ns.OiSving.Storage.getWithMigration(
      'oisving.sound.muted',
      'kurve.sound.muted',
      'sessionStorage',
    )
    expect(result).toBe(true)
    expect(ns.OiSving.Storage.has('oisving.sound.muted', 'sessionStorage')).toBe(true)
    expect(ns.OiSving.Storage.has('oisving.sound.muted', 'localStorage')).toBe(false)
  })
})
