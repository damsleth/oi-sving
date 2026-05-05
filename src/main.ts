// Bun build entry point. Each module augments the shared OiSving namespace,
// and several modules depend on others having registered their slot first
// (e.g. Game reads from Field, Curve reads from Superpower). Keep the order
// below stable.

import './window'
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
import './OiSvingPiwik'
import './OiSvingPrivacypolicy'
import './OiSving'
// Multiplayer surface. net.ts attaches OiSving.Net so Menu/Game can
// invoke host()/join()/startRound() once the inline UI wires them up.
import './net'

document.addEventListener('DOMContentLoaded', () => OiSving.init())
window.addEventListener('beforeunload', () => OiSving.onUnload())
