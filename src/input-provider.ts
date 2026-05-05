// Input source indirection. Curve physics and the superpower hooks read
// the active input bitfield through `getInput()` rather than touching
// `Game.keysDown` directly, so the same code path drives single-player
// keyboard, split-keyboard, and remote network players without diverging.
//
// Bit layout for the per-player frame input:
//   bit 0 = LEFT pressed
//   bit 1 = RIGHT pressed
//   bit 2 = SUPERPOWER pressed
//
// Local players ALSO have their input scheduled `INPUT_DELAY_FRAMES` frames
// in the future via the same mechanism remote players use, so that when the
// network layer turns on, the perceived control latency is identical for
// every player on every peer. This is the lockstep "feel preservation"
// trick: own input is not waiting for a network round-trip, but every
// player's input lands at the same scheduled frame.

export type InputBits = number

export const INPUT_LEFT = 1 << 0
export const INPUT_RIGHT = 1 << 1
export const INPUT_SUPERPOWER = 1 << 2

export interface InputProvider {
  // Return the input bitfield for `playerId` at simulation `frameId`.
  // The caller treats a missing input the same as zero; providers are
  // responsible for repeating the last-known input on missing frames so
  // dropped network packets do not stall the physics step.
  get(frameId: number, playerId: string): InputBits

  // Submit `bits` as the local input for `playerId` for frame `frameId`.
  // For the keyboard provider this is a no-op (the polling loop owns it).
  // For the network provider this enqueues the bits for transmission and
  // schedules them locally to take effect at frameId + INPUT_DELAY_FRAMES.
  submit(frameId: number, playerId: string, bits: InputBits): void
}

// Default provider used in single-player and split-keyboard mode. It
// reflects whatever Game.keysDown sees right now, which is exactly the
// pre-multiplayer behavior: zero input delay, polled at the call site.
class KeyboardInputProvider implements InputProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private game: any) {}

  get(_frameId: number, playerId: string): InputBits {
    // The OiSving namespace is attached to window by namespace.ts. We pull
    // through it here rather than re-importing the namespace module to
    // avoid a circular import (input-provider <-> namespace via Game).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (window as unknown as { OiSving: any }).OiSving
    const player = ns?.getPlayer?.(playerId)
    if (!player) return 0
    let bits = 0
    if (this.game.isKeyDown(player.getKeyLeft())) bits |= INPUT_LEFT
    if (this.game.isKeyDown(player.getKeyRight())) bits |= INPUT_RIGHT
    if (this.game.isKeyDown(player.getKeySuperpower())) bits |= INPUT_SUPERPOWER
    return bits
  }

  submit(_frameId: number, _playerId: string, _bits: InputBits): void {
    // No-op: keyboard polling already drives Game.keysDown directly.
  }
}

let activeProvider: InputProvider | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installKeyboardProvider(game: any): InputProvider {
  activeProvider = new KeyboardInputProvider(game)
  return activeProvider
}

export function setInputProvider(p: InputProvider): void {
  activeProvider = p
}

export function getInputProvider(): InputProvider {
  if (!activeProvider) {
    throw new Error('Input provider not installed. Call installKeyboardProvider on game init.')
  }
  return activeProvider
}

// Convenience accessor for call sites that previously polled directly:
//   if (game.isKeyDown(curve.getPlayer().getKeyLeft())) { ... }
// becomes
//   if (input(frameId, curve.getPlayer().getId()) & INPUT_LEFT) { ... }
export function input(frameId: number, playerId: string): InputBits {
  return getInputProvider().get(frameId, playerId)
}
