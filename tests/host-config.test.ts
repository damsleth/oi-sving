// Tests for the joiner-side host-config override. The host's MSG_START
// carries an authoritative copy of every simulation-affecting Config
// value; on the joiner, applyHostConfig clobbers OiSving.Config with
// those values BEFORE NetInputProvider and Game read them, so a joiner
// running a slightly different build cannot drift via local-default
// config.

import { describe, expect, test } from 'bun:test'
import { applyHostConfig, type ConfigRoot, type GameRef, type HostSimConfig } from '../src/host-config'

const sample: HostSimConfig = {
  inputDelayFrames: 3,
  inputRedundancyFrames: 6,
  stateHashIntervalFrames: 30,
  fps: 90,
  holeInterval: 200,
  holeIntervalRandomness: 400,
  initialSuperpowerCount: 3,
  // red, blue, green
  allowedPlayerMask: (1 << 0) | (1 << 2) | (1 << 3),
  arenaWidth: 1024,
  arenaHeight: 768,
}

describe('applyHostConfig', () => {
  test('writes Net fields exactly as supplied', () => {
    const cfg: ConfigRoot = { Net: {} }
    applyHostConfig(sample, cfg, null)
    expect(cfg.Net).toEqual({
      inputDelayFrames: 3,
      inputRedundancyFrames: 6,
      stateHashIntervalFrames: 30,
      arenaWidth: 1024,
      arenaHeight: 768,
    })
  })

  test('writes Game fields exactly as supplied', () => {
    const cfg: ConfigRoot = { Game: {} }
    applyHostConfig(sample, cfg, null)
    expect(cfg.Game).toEqual({ fps: 90, initialSuperpowerCount: 3 })
  })

  test('writes Curve fields exactly as supplied', () => {
    const cfg: ConfigRoot = { Curve: {} }
    applyHostConfig(sample, cfg, null)
    expect(cfg.Curve).toEqual({ holeInterval: 200, holeIntervalRandomness: 400 })
  })

  test('trims Players to the allowed mask, preserving table order', () => {
    const cfg: ConfigRoot = {
      Players: [
        { id: 'red' },
        { id: 'orange' },
        { id: 'green' },
        { id: 'blue' },
        { id: 'purple' },
        { id: 'pink' },
      ],
    }
    applyHostConfig(sample, cfg, null)
    expect(cfg.Players?.map(p => p.id)).toEqual(['red', 'green', 'blue'])
  })

  test('zero allowed-mask leaves Players untouched (mask=0 is treated as "no constraint")', () => {
    // The intent of "host disabled all colors" can't be expressed by
    // the same mask-bit channel that means "host's config wasn't sent
    // explicitly", so the implementation chooses the safer permissive
    // interpretation: don't filter when mask is empty.
    const cfg: ConfigRoot = {
      Players: [{ id: 'red' }, { id: 'blue' }],
    }
    applyHostConfig({ ...sample, allowedPlayerMask: 0 }, cfg, null)
    expect(cfg.Players?.map(p => p.id)).toEqual(['red', 'blue'])
  })

  test('trims Players when only some entries match the mask', () => {
    const cfg: ConfigRoot = {
      Players: [{ id: 'red' }, { id: 'orange' }, { id: 'pink' }],
    }
    applyHostConfig({ ...sample, allowedPlayerMask: (1 << 0) | (1 << 5) }, cfg, null)
    expect(cfg.Players?.map(p => p.id)).toEqual(['red', 'pink'])
  })

  test('refreshes Game.fps and intervalTimeOut so setInterval ticks at host rate', () => {
    const game: GameRef = { fps: 60, intervalTimeOut: 17 }
    applyHostConfig(sample, { Game: {} }, game)
    expect(game.fps).toBe(90)
    expect(game.intervalTimeOut).toBe(Math.round(1000 / 90))
  })

  test('null cfgRoot is a no-op (won\'t throw before OiSving.Config is wired)', () => {
    const game: GameRef = { fps: 60 }
    expect(() => applyHostConfig(sample, null, game)).not.toThrow()
    // No game write either when cfgRoot is null — nothing to apply.
    expect(game.fps).toBe(60)
  })

  test('null gameRef is a no-op for the live-tick refresh', () => {
    const cfg: ConfigRoot = { Net: {}, Game: {} }
    expect(() => applyHostConfig(sample, cfg, null)).not.toThrow()
    expect(cfg.Net?.arenaWidth).toBe(1024)
  })

  test('missing Net/Game/Curve sub-objects are skipped without error', () => {
    // Defensive — Config is `any` in production and partial mocks in
    // tests should not need to populate every leaf.
    const cfg: ConfigRoot = {}
    const game: GameRef = {}
    expect(() => applyHostConfig(sample, cfg, game)).not.toThrow()
    expect(game.fps).toBe(90) // still applied because GameRef is direct
  })

  test('successive applies overwrite the previous host\'s values', () => {
    // If host changes its own Config and re-issues startRound, the
    // joiner should see the latest values, not a merge.
    const cfg: ConfigRoot = { Net: {}, Game: {}, Curve: {} }
    applyHostConfig(sample, cfg, null)
    applyHostConfig({ ...sample, fps: 30, holeInterval: 60 }, cfg, null)
    expect(cfg.Game?.fps).toBe(30)
    expect(cfg.Curve?.holeInterval).toBe(60)
    // Unaffected fields stay at the latest write (still the new value).
    expect(cfg.Net?.inputDelayFrames).toBe(3)
  })
})
