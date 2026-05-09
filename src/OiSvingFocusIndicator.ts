// Visual indicator that the tab is hidden or unfocused. Browsers throttle
// setInterval/setTimeout in non-foreground tabs (commonly to ~1Hz, with
// further "intensive throttling" after a few minutes), which breaks the
// host-state cadence and trips the joiner watchdog. This badge is a
// passive heads-up - it does NOT pause the watchdog or otherwise alter
// network behavior. See peer-reconnect-controller.ts and
// host-state-watchdog.ts for the actual reconnect logic.

import { OiSving } from './namespace'

OiSving.FocusIndicator = {
  el: null as HTMLElement | null,

  init: function () {
    this.el = document.getElementById('focus-indicator')
    if (!this.el) return

    const update = () => this.update()
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)

    if (OiSving.Net && typeof OiSving.Net.on === 'function') {
      OiSving.Net.on('connection-state', update)
    }

    this.update()
  },

  update: function () {
    if (!this.el) return
    const hidden = typeof document !== 'undefined' && document.hidden === true
    const unfocused = typeof document.hasFocus === 'function' && !document.hasFocus()
    const inMultiplayer = !!(OiSving.Net && typeof OiSving.Net.isActive === 'function' && OiSving.Net.isActive())

    if (!inMultiplayer || (!hidden && !unfocused)) {
      this.el.classList.add('hidden')
      return
    }

    const reason = hidden ? 'Tab hidden' : 'Tab unfocused'
    const body = this.el.querySelector('.focus-indicator-body') as HTMLElement | null
    if (body) body.textContent = reason + ' - browser may throttle timers, multiplayer can stutter'
    this.el.classList.remove('hidden')
  },
}
