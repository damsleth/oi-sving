// Touch + coarse pointer is the canonical signal for "this is a phone or
// tablet". UA hints catch desktop browsers in mobile-emulation mode (dev
// tools) but iPad on iOS 13+ ships a desktop UA - the coarse-pointer
// branch is what flips it correctly. Cached because the value can't
// change inside a session.

let cached: boolean | null = null

export function isMobile(): boolean {
  if (cached !== null) return cached
  // Probe globalThis directly so the function is testable from a
  // node-like runtime where `window` is undefined but a fake
  // navigator + matchMedia have been pinned for the test.
  const g = globalThis as {
    navigator?: { userAgent?: string; maxTouchPoints?: number }
    matchMedia?: (q: string) => { matches: boolean }
    ontouchstart?: unknown
  }
  if (!g.navigator) {
    cached = false
    return cached
  }

  const ua = g.navigator.userAgent || ''
  const uaHint = /iphone|ipad|ipod|android|mobile|tablet/i.test(ua)
  const coarse = typeof g.matchMedia === 'function' && g.matchMedia('(pointer: coarse)').matches
  const touch = (g.navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in g

  cached = (coarse && touch) || (uaHint && touch)
  return cached
}

// Test hook. Reset between cases that mutate window/navigator.
export function __resetMobileDetectCache(): void {
  cached = null
}
