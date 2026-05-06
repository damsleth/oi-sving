// Lockstep network input provider. Pulled out of net.ts so the
// redundancy-ring logic can be unit-tested without dragging the WebRTC +
// signaling module side effects into the test runtime.
//
// Each local input submission is:
//   1. written to the local InputBuffer at the scheduled frame
//      (`frameId + inputDelay`) so own input experiences the same
//      perceived delay every other peer's input does;
//   2. appended to a per-player ring of the last `redundancy` frames;
//   3. broadcast as that ring via `broadcastFn`. The wire packet
//      thereby covers the most recent N frames, so a single drop on
//      the unordered + maxRetransmits=0 input channel is repaired by
//      the next packet.

import type { InputBits, InputProvider } from './input-provider'
import type { InputBuffer } from './input-buffer'

export interface InputEntry { frameId: number; bits: InputBits }

export type BroadcastFn = (playerId: string, ring: InputEntry[]) => void

export class NetInputProvider implements InputProvider {
  private history = new Map<string, InputEntry[]>()

  constructor(
    private buffer: InputBuffer,
    private inputDelay: number,
    private redundancy: number = 4,
    // Sender-side broadcast hook. Default is a no-op so the provider
    // can be constructed in tests without a network surface.
    private broadcastFn: BroadcastFn = () => {},
  ) {}

  get(frameId: number, playerId: string): InputBits {
    return this.buffer.get(frameId, playerId)
  }

  submit(frameId: number, playerId: string, bits: InputBits): void {
    const scheduled = frameId + this.inputDelay
    this.buffer.set(scheduled, playerId, bits)

    const ring = this.history.get(playerId) ?? []
    ring.push({ frameId: scheduled, bits })
    while (ring.length > this.redundancy) ring.shift()
    this.history.set(playerId, ring)

    // Pass the ring as a fresh array so callers (notably the broadcast
    // path) can store it without our subsequent mutations leaking.
    this.broadcastFn(playerId, [...ring])
  }
}
