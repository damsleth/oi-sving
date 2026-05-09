// Pure decision logic for relative-thumb steering. Verifies the deadzone
// holds neutral when the finger is held still on the origin, and snaps
// to LEFT/RIGHT past the threshold without ambiguity at the boundary.

import { describe, expect, test } from 'bun:test'
import { steerFromDelta, DEFAULT_RELATIVE_DEADZONE_PX } from '../src/touch-steering'

describe('steerFromDelta', () => {
  test('exact origin holds neutral', () => {
    expect(steerFromDelta(200, 200)).toBe('none')
  })

  test('inside deadzone holds neutral on either side', () => {
    expect(steerFromDelta(200, 200 + (DEFAULT_RELATIVE_DEADZONE_PX - 1))).toBe('none')
    expect(steerFromDelta(200, 200 - (DEFAULT_RELATIVE_DEADZONE_PX - 1))).toBe('none')
  })

  test('boundary is exclusive: dx == deadzone counts as past threshold', () => {
    // Math.abs(dx) < deadzone => neutral. At ==, we steer.
    expect(steerFromDelta(200, 200 + DEFAULT_RELATIVE_DEADZONE_PX)).toBe('right')
    expect(steerFromDelta(200, 200 - DEFAULT_RELATIVE_DEADZONE_PX)).toBe('left')
  })

  test('clear left / right past the deadzone', () => {
    expect(steerFromDelta(200, 100)).toBe('left')
    expect(steerFromDelta(200, 320)).toBe('right')
  })

  test('custom deadzone overrides the default', () => {
    // 5 px past origin would be neutral with default 12 px deadzone, but
    // counts as a steer with a 4 px deadzone.
    expect(steerFromDelta(200, 205, 4)).toBe('right')
    expect(steerFromDelta(200, 205, 12)).toBe('none')
  })

  test('zero deadzone makes any non-zero delta a steer', () => {
    expect(steerFromDelta(200, 201, 0)).toBe('right')
    expect(steerFromDelta(200, 199, 0)).toBe('left')
    expect(steerFromDelta(200, 200, 0)).toBe('none')
  })
})
