// Per-(frame, playerId) input bitfield store used by the lockstep
// network input provider.
//
// Determinism contract:
//   - set() is idempotent on (frameId, playerId).
//   - get(frameId, playerId) returns either the exact bits stored for
//     that frame OR, if missing, the bits from the highest known
//     frame strictly less-than-or-equal-to frameId for that player.
//     Frames AFTER `frameId` MUST NOT contribute to the answer —
//     otherwise late-arriving future packets would retroactively
//     change earlier frames' input on whichever peer received them
//     out-of-order, causing two peers with the same eventual packet
//     set to disagree on intermediate frames.
//   - prune() preserves a sentinel at `keepFromFrame - 1` so the
//     fallback for newly-requested frames after a prune still has the
//     correct held-key value.
//
// The input channel is `ordered: false`, `maxRetransmits: 0`, so
// reordering and single-packet drops are normal. Sender-side
// redundancy + this frame-bounded fallback are what make peers
// converge on the same answer regardless of arrival order.

import type { InputBits } from './input-provider'

export class InputBuffer {
  private cells = new Map<string, InputBits>()
  private framesByPlayer = new Map<string, Map<number, InputBits>>()

  set(frameId: number, playerId: string, bits: InputBits): void {
    this.cells.set(`${frameId}|${playerId}`, bits)
    let frames = this.framesByPlayer.get(playerId)
    if (!frames) {
      frames = new Map()
      this.framesByPlayer.set(playerId, frames)
    }
    frames.set(frameId, bits)
  }

  get(frameId: number, playerId: string): InputBits {
    const exact = this.cells.get(`${frameId}|${playerId}`)
    if (exact !== undefined) return exact

    const frames = this.framesByPlayer.get(playerId)
    if (!frames) return 0

    let bestFrame = -1
    let bestBits: InputBits = 0
    for (const [knownFrame, bits] of frames) {
      if (knownFrame <= frameId && knownFrame > bestFrame) {
        bestFrame = knownFrame
        bestBits = bits
      }
    }
    return bestBits
  }

  prune(keepFromFrame: number): void {
    for (const k of this.cells.keys()) {
      const frame = Number(k.split('|')[0])
      if (frame < keepFromFrame) this.cells.delete(k)
    }
    // Fold every frame strictly older than keepFromFrame into a single
    // sentinel at `keepFromFrame - 1` carrying the most-recent pre-window
    // bits. That preserves the "held key" semantics for later get()
    // calls without keeping unbounded history per player.
    for (const frames of this.framesByPlayer.values()) {
      let sentinelFrame = -1
      let sentinelBits: InputBits = 0
      for (const [frame, bits] of frames) {
        if (frame < keepFromFrame && frame > sentinelFrame) {
          sentinelFrame = frame
          sentinelBits = bits
        }
      }
      for (const frame of [...frames.keys()]) {
        if (frame < keepFromFrame) frames.delete(frame)
      }
      if (sentinelFrame >= 0 && !frames.has(keepFromFrame - 1)) {
        frames.set(keepFromFrame - 1, sentinelBits)
      }
    }
  }
}
