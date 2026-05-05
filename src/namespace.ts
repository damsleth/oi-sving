// Shared OiSving namespace object. Each module augments OiSving.<Section> on
// load. Kept as `any` to mirror the legacy global namespace shape exactly while
// the per-module typings are introduced incrementally; tightening these types
// is a follow-up that does not affect the build.

import * as PIXI from 'pixi.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OiSvingNamespace = any

export const OiSving: OiSvingNamespace = {
  players: [],
  playersById: {},
}

declare global {
  interface Window {
    OiSving: OiSvingNamespace
    PIXI: typeof PIXI
    // Legacy short alias for OiSving.Utility, populated by ./utility.ts.
    // Keep it on `window` so inline handlers and helpers that referenced
    // `u` as a free variable continue to resolve.
    u: OiSvingNamespace
    _paq?: unknown[]
  }
}

// Inline `onclick=` handlers in index.html still reference `OiSving.*`.
// Attach the namespace to `window` so those resolve.
window.OiSving = OiSving

// Make PIXI globally available so legacy code that referenced `new PIXI.X()`
// without an import statement keeps working as we migrate file by file.
window.PIXI = PIXI
