// Bun build entry point. Module load order matches the legacy Gulp source list
// in gulpfile.js, so OiSving namespace augmentation happens in the same
// sequence the original concatenated bundle expected.

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
