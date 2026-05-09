// Mobile detection: combines pointer-coarse media query, touch points,
// and a UA hint. iPad on iOS 13+ ships a desktop UA so the
// (coarse && touch) branch is the load-bearing one for tablets.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { isMobile, __resetMobileDetectCache } from '../src/mobile-detect'

interface FakeNav {
  userAgent: string
  maxTouchPoints: number
}

function setNavigator(nav: FakeNav): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: nav,
    configurable: true,
    writable: true,
  })
}

function setMatchMedia(coarse: boolean): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    value: (q: string) => ({
      matches: q.includes('coarse') ? coarse : false,
      media: q,
      addListener() { /* */ },
      removeListener() { /* */ },
      addEventListener() { /* */ },
      removeEventListener() { /* */ },
      dispatchEvent() { return true },
      onchange: null,
    }),
    configurable: true,
    writable: true,
  })
}

function setOnTouchStart(present: boolean): void {
  if (present) (globalThis as unknown as { ontouchstart?: unknown }).ontouchstart = null
  else delete (globalThis as unknown as { ontouchstart?: unknown }).ontouchstart
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15'

describe('isMobile', () => {
  let originalNav: PropertyDescriptor | undefined
  let originalMM: PropertyDescriptor | undefined
  let originalOTS: unknown

  beforeEach(() => {
    __resetMobileDetectCache()
    originalNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    originalMM = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
    originalOTS = (globalThis as unknown as { ontouchstart?: unknown }).ontouchstart
  })

  afterEach(() => {
    if (originalNav) Object.defineProperty(globalThis, 'navigator', originalNav)
    else delete (globalThis as unknown as { navigator?: unknown }).navigator
    if (originalMM) Object.defineProperty(globalThis, 'matchMedia', originalMM)
    else delete (globalThis as unknown as { matchMedia?: unknown }).matchMedia
    if (originalOTS === undefined) delete (globalThis as unknown as { ontouchstart?: unknown }).ontouchstart
    else (globalThis as unknown as { ontouchstart?: unknown }).ontouchstart = originalOTS
    __resetMobileDetectCache()
  })

  test('iPhone Safari: UA hint + touch -> mobile', () => {
    setNavigator({ userAgent: IPHONE_UA, maxTouchPoints: 5 })
    setMatchMedia(true)
    expect(isMobile()).toBe(true)
  })

  test('Android Chrome: UA hint + touch -> mobile', () => {
    setNavigator({ userAgent: ANDROID_UA, maxTouchPoints: 5 })
    setMatchMedia(true)
    expect(isMobile()).toBe(true)
  })

  test('iPad on iOS 13+ ships desktop UA, but coarse + touch -> mobile', () => {
    setNavigator({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 })
    setMatchMedia(true)
    expect(isMobile()).toBe(true)
  })

  test('plain desktop: no coarse, no touch, no UA hint -> not mobile', () => {
    setNavigator({ userAgent: DESKTOP_UA, maxTouchPoints: 0 })
    setMatchMedia(false)
    setOnTouchStart(false)
    expect(isMobile()).toBe(false)
  })

  test('mobile UA spoof on desktop without touch -> not mobile (uaHint && touch is the gate)', () => {
    setNavigator({ userAgent: IPHONE_UA, maxTouchPoints: 0 })
    setMatchMedia(false)
    setOnTouchStart(false)
    expect(isMobile()).toBe(false)
  })

  test('coarse pointer alone (e.g. TV remote) without touch points or UA -> not mobile', () => {
    setNavigator({ userAgent: DESKTOP_UA, maxTouchPoints: 0 })
    setMatchMedia(true)
    setOnTouchStart(false)
    expect(isMobile()).toBe(false)
  })

  test('result is cached: subsequent reads do not re-query the environment', () => {
    setNavigator({ userAgent: IPHONE_UA, maxTouchPoints: 5 })
    setMatchMedia(true)
    expect(isMobile()).toBe(true)
    // Flip the environment to "definitely desktop" - cached value must
    // not change without an explicit reset.
    setNavigator({ userAgent: DESKTOP_UA, maxTouchPoints: 0 })
    setMatchMedia(false)
    setOnTouchStart(false)
    expect(isMobile()).toBe(true)
    __resetMobileDetectCache()
    expect(isMobile()).toBe(false)
  })
})
