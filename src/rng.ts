// Deterministic seeded PRNG. Replaces Math.random() at the five legacy call
// sites that affect simulation: random initial angle, hole interval randomness,
// random spawn position X/Y, and random superpower picker. Lockstep multiplayer
// requires every peer to draw the same numbers in the same order — that is only
// safe with a host-issued seed and a fixed iteration order.
//
// Mulberry32 chosen for its tiny implementation (one 32-bit state word, ~5
// arithmetic ops per draw) and acceptable statistical quality for game RNG.

export class Rng {
  private state: number

  constructor(seed: number) {
    // Mulberry32 expects a 32-bit unsigned seed. Force into uint32.
    this.state = seed >>> 0
  }

  // Reseed in place. Used when the host hands a new seed at round start.
  seed(seed: number): void {
    this.state = seed >>> 0
  }

  // Draw a uniform float in [0, 1). Same shape as Math.random().
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // Draw a uniform float in [lo, hi). Mirrors `lo + Math.random()*(hi-lo)`.
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo)
  }

  // Draw a uniform integer in [lo, hi].
  rangeInt(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1))
  }
}

// Process-wide RNG used by the game simulation. Replaced via `setSimRng`
// when the host issues a seed at network round start. In single-player it
// is seeded once at startup with `Date.now()` so each round still feels
// random but every draw within a round is reproducible.
let simRng = new Rng(Date.now() >>> 0)

export function getSimRng(): Rng {
  return simRng
}

export function setSimRng(rng: Rng): void {
  simRng = rng
}

// Convenience wrappers so call sites read `rand()` / `rand.range(a,b)`
// rather than `getSimRng().next()`.
export const rand = {
  next: () => simRng.next(),
  range: (lo: number, hi: number) => simRng.range(lo, hi),
  rangeInt: (lo: number, hi: number) => simRng.rangeInt(lo, hi),
}
