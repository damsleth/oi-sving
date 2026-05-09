// Pure decision logic for relative-thumb steering, factored out of
// OiSvingTouchControls so it can be unit-tested without a real DOM.
// Given the origin set on first touch and the current pointer X, decide
// whether the user wants to steer LEFT, RIGHT, or hold neutral. The
// deadzone keeps a finger held dead-still on the origin from rapidly
// flapping LEFT/RIGHT around the centerline.

export type SteerDirection = 'left' | 'right' | 'none'

export const DEFAULT_RELATIVE_DEADZONE_PX = 12

export function steerFromDelta(
  originX: number,
  currentX: number,
  deadzonePx: number = DEFAULT_RELATIVE_DEADZONE_PX,
): SteerDirection {
  const dx = currentX - originX
  if (dx === 0) return 'none'
  if (Math.abs(dx) < deadzonePx) return 'none'
  return dx < 0 ? 'left' : 'right'
}
