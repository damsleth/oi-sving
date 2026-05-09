// Production-build dead-code-elim guard. The dev-reload bridge is
// gated on a __DEV__ literal that scripts/build.ts replaces with
// `false` whenever NODE_ENV != 'development'. If that contract ever
// breaks (forgotten define, refactor that reaches process.env at
// runtime, etc.), the prod bundle would either ship a dev hot-reload
// EventSource open against /__reload on every page load, or throw a
// ReferenceError on startup because `process` doesn't exist in the
// browser. Both are silent regressions worth catching at CI time.

import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const bundlePath = join(new URL('..', import.meta.url).pathname.replace(/\/$/, ''), 'dist/js/oisving.min.js')

describe('production bundle', () => {
  test('the bundle exists (pretest hook ran a build)', () => {
    expect(existsSync(bundlePath)).toBe(true)
  })

  test('prod bundle contains no __DEV__ literal, no /__reload subscription, no EventSource open', () => {
    const src = readFileSync(bundlePath, 'utf8')
    // __DEV__ should be replaced with `false` and never appear by name.
    expect(src.includes('__DEV__')).toBe(false)
    // /__reload is the dev-only SSE path; never requested from prod.
    expect(src.includes('/__reload')).toBe(false)
    // EventSource is only instantiated by dev-reload.ts.
    expect(src.includes('new EventSource')).toBe(false)
  })
})
