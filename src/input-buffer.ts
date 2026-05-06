// Per-(frame, playerId) input bitfield store used by the lockstep
// network input provider. Extracted from src/net.ts so it can be
// unit-tested without dragging the whole RTC + signaling surface
// (which has side effects on import) into the test runtime.
//
// The input channel is unordered + maxRetransmits=0, so packets can
// arrive out of order and individual packets can drop. The buffer
// converges across peers because:
//   - set() is idempotent on (frameId, playerId).
//   - Each broadcast packet carries a redundancy window so a single
//     drop is repaired by the next packet.
//   - The fallback (lastBitsByPlayer) tracks the latest *frame* —
//     not the latest *arrival* — so out-of-order delivery doesn't
//     give peers different "most recent" bits for the same player.

import type { InputBits } from './input-provider'

export class InputBuffer {
  private cells = new Map<string, InputBits>()
  private lastBitsByPlayer = new Map<string, InputBits>()
  private lastFrameByPlayer = new Map<string, number>()

  set(frameId: number, playerId: string, bits: InputBits): void {
    this.cells.set(`${frameId}|${playerId}`, bits)
    const prevMax = this.lastFrameByPlayer.get(playerId) ?? -1
    if (frameId > prevMax) {
      this.lastFrameByPlayer.set(playerId, frameId)
      this.lastBitsByPlayer.set(playerId, bits)
    }
  }

  get(frameId: number, playerId: string): InputBits {
    const exact = this.cells.get(`${frameId}|${playerId}`)
    if (exact !== undefined) return exact
    return this.lastBitsByPlayer.get(playerId) ?? 0
  }

  prune(keepFromFrame: number): void {
    for (const k of this.cells.keys()) {
      const frame = Number(k.split('|')[0])
      if (frame < keepFromFrame) this.cells.delete(k)
    }
  }
}
