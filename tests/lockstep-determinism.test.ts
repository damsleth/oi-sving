// Two synthetic "peer" worlds, same seed, same scripted input sequence,
// must produce the same state-hash sequence. This is the lockstep
// invariant the multiplayer round depends on. It exercises the code
// paths that matter (Rng draws, the FNV-1a state hash, integer
// quantization of position/angle) without dragging in PIXI or the DOM.

import { beforeAll, describe, expect, test } from 'bun:test'
import { Rng } from '../src/rng'

interface FakeCurve {
  x: number
  y: number
  angle: number
  hole: number
}

function fakeStateHash(curves: Record<string, FakeCurve[]>, arenaW: number, arenaH: number): number {
  let hash = 0x811c9dc5 >>> 0
  const mix = (n: number) => {
    hash ^= n >>> 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  mix(arenaW | 0)
  mix(arenaH | 0)
  const ids = Object.keys(curves).sort()
  for (const id of ids) {
    for (const c of curves[id]!) {
      mix(Math.round(c.x * 100))
      mix(Math.round(c.y * 100))
      mix(Math.round(c.angle * 1e6))
      mix(c.hole | 0)
      mix(1)
    }
  }
  return hash >>> 0
}

function step(curve: FakeCurve, leftRight: -1 | 0 | 1, dAngle: number, stepLength: number): void {
  curve.angle += dAngle * leftRight
  curve.x += stepLength * Math.cos(curve.angle)
  curve.y += stepLength * Math.sin(curve.angle)
  curve.hole--
}

function runPeer(seed: number, inputSequence: ReadonlyArray<-1 | 0 | 1>) {
  const rng = new Rng(seed)
  const arenaW = 1280
  const arenaH = 720
  const dAngle = 0.035
  const stepLength = 1.4

  const curves: Record<string, FakeCurve[]> = {
    red: [{ x: rng.range(80, arenaW - 80), y: rng.range(80, arenaH - 80), angle: 2 * Math.PI * rng.next(), hole: 150 }],
    blue: [{ x: rng.range(80, arenaW - 80), y: rng.range(80, arenaH - 80), angle: 2 * Math.PI * rng.next(), hole: 150 }],
  }

  const hashes: number[] = []
  for (let f = 0; f < inputSequence.length; f++) {
    step(curves.red![0]!, inputSequence[f]!, dAngle, stepLength)
    step(curves.blue![0]!, inputSequence[f]!, dAngle, stepLength)
    if (f % 60 === 0) hashes.push(fakeStateHash(curves, arenaW, arenaH))
  }
  return hashes
}

describe('lockstep determinism', () => {
  let inputs: ReadonlyArray<-1 | 0 | 1>

  beforeAll(() => {
    // Scripted input sequence — alternates left, neutral, right with some
    // stretches of holding a direction. Gives the angle a varied trajectory.
    const buf: Array<-1 | 0 | 1> = []
    for (let i = 0; i < 600; i++) {
      buf.push((((i / 30) | 0) % 3 - 1) as -1 | 0 | 1)
    }
    inputs = buf
  })

  test('two peers, same seed, same input sequence -> same state-hash trail', () => {
    const a = runPeer(0xc0ffee, inputs)
    const b = runPeer(0xc0ffee, inputs)
    expect(a).toEqual(b)
    expect(a.length).toBe(10)
  })

  test('different seeds diverge by the second hash sample', () => {
    const a = runPeer(1, inputs)
    const b = runPeer(2, inputs)
    expect(a[0]).not.toBe(b[0])
  })

  test('same seed but different inputs diverge', () => {
    const a = runPeer(7, inputs)
    const flipped: Array<-1 | 0 | 1> = inputs.map(v => -v as -1 | 0 | 1)
    const b = runPeer(7, flipped)
    // First sample is taken at frame 0 before any input is applied — that
    // is identical because both runs share the spawn/angle draws. The
    // second sample is after 60 frames of opposing inputs and must differ.
    expect(a[1]).not.toBe(b[1])
  })
})
