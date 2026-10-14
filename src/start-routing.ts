// Routing for master-driven round starts. Kept pure so the screen/phase
// decision is testable without the OiSving namespace.

export interface GamePhase {
  gameScreenActive: boolean
  countdownPending: boolean
  isRoundStarted: boolean
  isRunning: boolean
  isPaused: boolean
  isGameOver: boolean
}

export type HostStartRoute = 'menu-start' | 'round-start' | 'ignore'

// A MSG_START_REQUEST must not re-enter the menu start path once the game
// screen is up (it would re-init the field mid-game), and must not touch a
// round that is running, paused, finished or about to be started by the
// countdown.
export function routeHostStartRequest(p: GamePhase): HostStartRoute {
  if (!p.gameScreenActive) return 'menu-start'
  if (p.countdownPending) return 'ignore'
  if (p.isRoundStarted || p.isRunning || p.isPaused || p.isGameOver) return 'ignore'
  return 'round-start'
}

export type JoinerSpaceRoute = 'request' | 'noop'

// Pause, unpause and reload stay host-only; a joiner space press only ever
// asks the host for the next round, and only as master between rounds.
export function routeJoinerGameSpace(p: GamePhase & { isMaster: boolean; canStart: boolean }): JoinerSpaceRoute {
  if (!p.isMaster || !p.canStart) return 'noop'
  if (p.countdownPending || p.isRoundStarted || p.isRunning || p.isPaused || p.isGameOver) return 'noop'
  return 'request'
}
