// Joiner-side host-config application. Pulled out of net.ts so the
// override logic can be unit-tested without an OiSving namespace
// stand-in. The host broadcasts a HostSimConfig in MSG_START; the
// joiner applies it to its local OiSving.Config tree before the
// network input provider and the game tick are constructed, so a
// joiner running a slightly different build cannot drift via
// compiled-default config.
//
// The function takes the config root and an optional game reference
// rather than touching OiSving.* directly. net.ts wraps it with the
// real refs; tests pass plain objects.

import { playerMaskToIds } from './net-protocol'

export interface HostSimConfig {
  inputDelayFrames: number
  inputRedundancyFrames: number
  stateHashIntervalFrames: number
  fps: number
  holeInterval: number
  holeIntervalRandomness: number
  initialSuperpowerCount: number
  allowedPlayerMask: number
  arenaWidth: number
  arenaHeight: number
}

// Loose shape — the legacy OiSving.Config is `any` in production, and
// we only ever read/write a fixed set of leaf fields.
export interface ConfigRoot {
  Net?: {
    inputDelayFrames?: number
    inputRedundancyFrames?: number
    stateHashIntervalFrames?: number
    arenaWidth?: number
    arenaHeight?: number
  }
  Game?: { fps?: number; initialSuperpowerCount?: number }
  Curve?: { holeInterval?: number; holeIntervalRandomness?: number }
  Players?: Array<{ id: string }>
}

export interface GameRef {
  fps?: number
  intervalTimeOut?: number
}

export function applyHostConfig(
  cfg: HostSimConfig,
  cfgRoot: ConfigRoot | null | undefined,
  gameRef: GameRef | null | undefined,
): void {
  if (!cfgRoot) return

  if (cfgRoot.Net) {
    cfgRoot.Net.inputDelayFrames = cfg.inputDelayFrames
    cfgRoot.Net.inputRedundancyFrames = cfg.inputRedundancyFrames
    cfgRoot.Net.stateHashIntervalFrames = cfg.stateHashIntervalFrames
    cfgRoot.Net.arenaWidth = cfg.arenaWidth
    cfgRoot.Net.arenaHeight = cfg.arenaHeight
  }
  if (cfgRoot.Game) {
    cfgRoot.Game.fps = cfg.fps
    cfgRoot.Game.initialSuperpowerCount = cfg.initialSuperpowerCount
  }
  if (cfgRoot.Curve) {
    cfgRoot.Curve.holeInterval = cfg.holeInterval
    cfgRoot.Curve.holeIntervalRandomness = cfg.holeIntervalRandomness
  }

  // allowedPlayerMask trims Config.Players to the host-allowed roster so
  // the menu only surfaces colors the host considers in play.
  const allowedIds = playerMaskToIds(cfg.allowedPlayerMask)
  if (allowedIds.length > 0 && Array.isArray(cfgRoot.Players)) {
    cfgRoot.Players = cfgRoot.Players.filter(p => allowedIds.includes(p.id))
  }

  // Game.fps + intervalTimeOut were captured from Config at init time, so
  // a Config update alone won't change the live tick rate. Refresh both
  // so setInterval ticks at the host's fps.
  if (gameRef) {
    gameRef.fps = cfg.fps
    gameRef.intervalTimeOut = Math.round(1000 / cfg.fps)
  }
}
