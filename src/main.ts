// Bun build entry point. Each module augments the shared OiSving namespace,
// and several modules depend on others having registered their slot first
// (e.g. Game reads from Field, Curve reads from Superpower). Keep the order
// below stable.

import './window'
import './dev-reload'
import { OiSving } from './namespace'
import './OiSvingStorage'
import './OiSvingUtility'
import './OiSvingSound'
import './OiSvingTheming'
import './OiSvingFactory'
import './OiSvingConfig'
import './OiSvingMenu'
import './OiSvingGame'
import './OiSvingField'
import './OiSvingSuperpowerconfig'
import './OiSvingSuperpower'
import './OiSvingCurve'
import './OiSvingPoint'
import './OiSvingPlayer'
import './OiSvingLightbox'
import './OiSving'
// Multiplayer surface. net.ts attaches OiSving.Net so Menu/Game can
// invoke host()/join()/startRound() once the inline UI wires them up.
import './net'
import './OiSvingToasts'
import './OiSvingFocusIndicator'
import './OiSvingTouchControls'

document.addEventListener('DOMContentLoaded', () => OiSving.init())

// Warn before navigating away from a live multiplayer session — refreshing
// or closing the tab tears down the WebRTC channel and the host has no
// graceful way to recover the joiner. Returning a string from the handler
// triggers the browser's "Leave site?" confirm in every supporting engine.
window.addEventListener('beforeunload', (event: BeforeUnloadEvent) => {
  if (OiSving.Net && typeof OiSving.Net.isActive === 'function' && OiSving.Net.isActive()) {
    event.preventDefault()
    event.returnValue = 'You are connected to a multiplayer game. Leaving now will drop you from the room.'
    return event.returnValue
  }
  return undefined
})

window.addEventListener('beforeunload', () => OiSving.onUnload())
