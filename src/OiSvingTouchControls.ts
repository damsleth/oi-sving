// Touch input bridge for mobile play. Translates Pointer Events into
// the same `OiSving.Game.keysDown` map the desktop keyboard handler
// writes to, so the existing input pipeline (Game.sampleAndSubmitLocalInputs
// -> InputProvider -> Net) stays untouched.
//
// Two modes, persisted in OiSvingStorage:
//
//   - 'relative': anywhere-thumb. The first finger down anchors the
//     origin; horizontal delta from that origin steers (x < origin =>
//     LEFT, x > origin => RIGHT). The deadzone keeps a finger held
//     dead-still from accidentally toggling. Superpower lives in a
//     fixed bottom-left corner button.
//
//   - 'buttons': three big tap zones along the bottom (left / super /
//     right). The superpower zone is hidden when the local player has
//     no superpower configured.
//
// The overlay is a sibling of the canvas inside #layer-game, so it
// hides automatically with the menu/game layer toggle. Pointer
// handlers always run but bail when the round is not active so menu
// taps still go through to the menu UI.

import { OiSving } from './namespace'
import { steerFromDelta } from './touch-steering'

type Mode = 'relative' | 'buttons'

const STORAGE_KEY = 'touch-controls-mode'

OiSving.TouchControls = {
  mode: 'relative' as Mode,
  overlay: null as HTMLElement | null,
  buttonsRoot: null as HTMLElement | null,
  relativeRoot: null as HTMLElement | null,
  relativeOrigin: null as HTMLElement | null,
  toggleEl: null as HTMLElement | null,
  superButtonsByMode: {} as Record<'buttons' | 'relative', HTMLElement | null>,
  activePointerId: null as number | null,
  originX: 0,
  superHeld: false,
  enabled: false,

  init: function () {
    this.overlay = document.getElementById('touch-overlay')
    if (!this.overlay) return

    this.buttonsRoot = document.getElementById('touch-buttons')
    this.relativeRoot = document.getElementById('touch-relative')
    this.relativeOrigin = document.getElementById('touch-relative-origin')
    this.toggleEl = document.getElementById('touch-mode-toggle')
    this.superButtonsByMode = {
      buttons: document.getElementById('touch-btn-super'),
      relative: document.getElementById('touch-relative-super'),
    }

    this.mode = this.loadMode()
    this.applyMode()

    this.bindButtons()
    this.bindRelative()

    if (OiSving.Net && typeof OiSving.Net.on === 'function') {
      // releaseAll on every round-start: a finger held when one round
      // ended would otherwise carry a synthetic LEFT/RIGHT/SUPER into
      // the next round's frame zero and pre-bend the new curve.
      OiSving.Net.on('round-start', () => { this.releaseAll(); this.enable() })
      OiSving.Net.on('host-gone', () => this.disable())
      OiSving.Net.on('peer-desync', () => this.disable())
    }
  },

  loadMode: function (): Mode {
    try {
      const v = OiSving.Storage && OiSving.Storage.get && OiSving.Storage.get(STORAGE_KEY)
      if (v === 'buttons' || v === 'relative') return v
    } catch { /* */ }
    return 'relative'
  },

  saveMode: function () {
    try {
      if (OiSving.Storage && OiSving.Storage.set) OiSving.Storage.set(STORAGE_KEY, this.mode)
    } catch { /* */ }
  },

  toggleMode: function () {
    this.releaseAll()
    this.mode = this.mode === 'relative' ? 'buttons' : 'relative'
    this.saveMode()
    this.applyMode()
  },

  applyMode: function () {
    if (!this.overlay) return
    this.overlay.classList.toggle('mode-relative', this.mode === 'relative')
    this.overlay.classList.toggle('mode-buttons', this.mode === 'buttons')
    this.refreshSuperVisibility()
  },

  refreshSuperVisibility: function () {
    const player = this.getLocalPlayer()
    const hasSuper = !!(
      player &&
      player.getSuperpower &&
      player.getSuperpower() &&
      OiSving.Superpowerconfig &&
      OiSving.Superpowerconfig.types &&
      player.getSuperpower().getType() !== OiSving.Superpowerconfig.types.NO_SUPERPOWER
    )
    for (const key of ['buttons', 'relative'] as const) {
      const el = this.superButtonsByMode[key]
      if (!el) continue
      el.classList.toggle('hidden', !hasSuper)
    }
  },

  enable: function () {
    if (!this.overlay) return
    if (typeof OiSving.isMobile === 'function' && !OiSving.isMobile()) return
    this.enabled = true
    this.overlay.classList.remove('hidden')
    this.refreshSuperVisibility()
  },

  disable: function () {
    this.enabled = false
    this.releaseAll()
    if (this.overlay) this.overlay.classList.add('hidden')
  },

  getLocalPlayer: function () {
    const players = OiSving.players || []
    for (const p of players) {
      if (typeof p.isActive === 'function' && p.isActive() && p.isLocal !== false) return p
    }
    return null
  },

  setKey: function (keyCode: number, down: boolean) {
    if (!OiSving.Game) return
    if (!OiSving.Game.keysDown) OiSving.Game.keysDown = {}
    if (down) OiSving.Game.keysDown[keyCode] = true
    else delete OiSving.Game.keysDown[keyCode]
  },

  releaseAll: function () {
    const player = this.getLocalPlayer()
    if (player) {
      this.setKey(player.getKeyLeft(), false)
      this.setKey(player.getKeyRight(), false)
      this.setKey(player.getKeySuperpower(), false)
    }
    this.activePointerId = null
    this.superHeld = false
    if (this.relativeOrigin) this.relativeOrigin.classList.remove('is-visible')
  },

  steer: function (dir: 'left' | 'right' | 'none') {
    const player = this.getLocalPlayer()
    if (!player) return
    this.setKey(player.getKeyLeft(), dir === 'left')
    this.setKey(player.getKeyRight(), dir === 'right')
  },

  superDown: function (down: boolean) {
    if (down === this.superHeld) return
    this.superHeld = down
    const player = this.getLocalPlayer()
    if (!player) return
    this.setKey(player.getKeySuperpower(), down)
  },

  bindButtons: function () {
    const setup = (id: string, on: () => void, off: () => void) => {
      const el = document.getElementById(id)
      if (!el) return
      const start = (e: Event) => { e.preventDefault(); if (this.enabled && this.mode === 'buttons') on() }
      const end = (e: Event) => { e.preventDefault(); off() }
      el.addEventListener('pointerdown', start)
      el.addEventListener('pointerup', end)
      el.addEventListener('pointercancel', end)
      el.addEventListener('pointerleave', end)
    }
    setup('touch-btn-left', () => this.steer('left'), () => this.steer('none'))
    setup('touch-btn-right', () => this.steer('right'), () => this.steer('none'))
    setup('touch-btn-super', () => this.superDown(true), () => this.superDown(false))
    setup('touch-relative-super', () => this.superDown(true), () => this.superDown(false))
  },

  bindRelative: function () {
    const surface = this.relativeRoot
    if (!surface) return

    surface.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.enabled || this.mode !== 'relative') return
      const target = e.target as HTMLElement | null
      if (target && target.closest && target.closest('#touch-relative-super')) return
      e.preventDefault()
      this.activePointerId = e.pointerId
      this.originX = e.clientX
      if (this.relativeOrigin) {
        this.relativeOrigin.style.left = `${e.clientX}px`
        this.relativeOrigin.style.top = `${e.clientY}px`
        this.relativeOrigin.classList.add('is-visible')
      }
      this.steer('none')
    })

    surface.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.activePointerId !== e.pointerId) return
      e.preventDefault()
      this.steer(steerFromDelta(this.originX, e.clientX))
    })

    const end = (e: PointerEvent) => {
      if (this.activePointerId !== e.pointerId) return
      this.activePointerId = null
      this.steer('none')
      if (this.relativeOrigin) this.relativeOrigin.classList.remove('is-visible')
    }
    surface.addEventListener('pointerup', end)
    surface.addEventListener('pointercancel', end)
  },
}
