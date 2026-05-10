// Mobile orientation handling. Three layers, in priority order:
//
//   1. PWA manifest declares orientation: landscape - iOS Home Screen
//      and Android standalone modes lock the device automatically.
//   2. In a regular browser tab the manifest is ignored, so we show a
//      "rotate your phone" overlay any time matchMedia(orientation:
//      portrait) matches.
//   3. The overlay carries a "Play in portrait anyway" toggle that
//      flips body.force-landscape on. The CSS rotate trick under
//      `@media (orientation: portrait)` rotates the entire layout
//      90deg so canvas, controls, and menus all render landscape on
//      a phone the user can't physically turn (mounted device, etc).
//      Toggle persists in OiSvingStorage so a refresh keeps the
//      forced layout.
//
// Listeners are passive: they run only on mobile and only react to
// matchMedia / orientationchange. No polling, no state outside the
// body class + storage flag.

import { OiSving } from './namespace'

const FORCE_KEY = 'orientation-force-landscape'

OiSving.Orientation = {
  promptEl: null as HTMLElement | null,
  forced: false,

  init: function () {
    if (typeof OiSving.isMobile === 'function' && !OiSving.isMobile()) return

    this.promptEl = document.getElementById('orientation-prompt')
    if (!this.promptEl) return

    try {
      const v = OiSving.Storage && OiSving.Storage.get && OiSving.Storage.get(FORCE_KEY)
      this.forced = v === '1' || v === 1 || v === true
    } catch { /* */ }

    if (this.forced) document.body.classList.add('force-landscape')

    const update = () => this.refresh()
    if (typeof matchMedia === 'function') {
      const mql = matchMedia('(orientation: portrait)')
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', update)
      else if (typeof mql.addListener === 'function') mql.addListener(update)
    }
    window.addEventListener('orientationchange', update)
    window.addEventListener('resize', update)

    this.refresh()
  },

  refresh: function () {
    if (!this.promptEl) return
    const portrait = typeof matchMedia === 'function' && matchMedia('(orientation: portrait)').matches
    // Hide the prompt whenever we're in landscape (physically rotated)
    // OR the user has opted into the forced-rotate fallback.
    const show = portrait && !this.forced
    this.promptEl.classList.toggle('hidden', !show)
  },

  toggleForce: function () {
    this.forced = !this.forced
    document.body.classList.toggle('force-landscape', this.forced)
    try {
      if (OiSving.Storage && OiSving.Storage.set) OiSving.Storage.set(FORCE_KEY, this.forced ? '1' : '0')
    } catch { /* */ }
    this.refresh()
  },
}
