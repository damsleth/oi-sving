// Frame-aligned drift detection for the host-authoritative multiplayer
// gossip protocol. Extracted from net.ts so the comparison logic can
// be unit-tested without booting WebRTC + signaling.
//
// The two-map structure exists because peers don't tick their hash
// gossip in lock-step wall-clock order: a remote hash for frame N can
// arrive before this peer has computed its own hash for frame N (and
// vice versa). Recomputing local hash at receive time would diff
// remote-state-at-N against local-state-at-(N+k) where k is wall-clock
// skew - a guaranteed false positive even when the simulation is
// perfectly deterministic. So:
//
//   - localByFrame caches our own hash for each frame we hashed
//   - pendingRemote caches remote hashes for frames we haven't hashed
//     yet
//   - whichever side fills in second triggers the comparison

export interface HashMismatchEvent {
  frameId: number
  expected: number  // remote
  actual: number    // local
}

export class StateHashCompare {
  private localByFrame = new Map<number, number>()
  private pendingRemote = new Map<number, number>()
  private readonly retainFrames: number

  constructor(retainFrames = 600) {
    this.retainFrames = retainFrames
  }

  // Called when this peer computes its own hash for a frame. Returns a
  // mismatch event if a remote hash for the same frame had been
  // pending and disagrees; returns null otherwise.
  reportLocal(frameId: number, hash: number): HashMismatchEvent | null {
    this.localByFrame.set(frameId, hash)
    this.pruneOlderThan(frameId)
    const pending = this.pendingRemote.get(frameId)
    if (typeof pending !== 'number') return null
    this.pendingRemote.delete(frameId)
    return pending !== hash ? { frameId, expected: pending, actual: hash } : null
  }

  // Called when a remote hash arrives for a frame. Returns a mismatch
  // event if this peer has already hashed that frame and disagrees;
  // returns null otherwise (and remembers the remote hash for the
  // eventual local report).
  reportRemote(frameId: number, hash: number): HashMismatchEvent | null {
    const mine = this.localByFrame.get(frameId)
    if (typeof mine === 'number') {
      return mine !== hash ? { frameId, expected: hash, actual: mine } : null
    }
    this.pendingRemote.set(frameId, hash)
    return null
  }

  clear(): void {
    this.localByFrame.clear()
    this.pendingRemote.clear()
  }

  private pruneOlderThan(currentFrame: number): void {
    const cutoff = currentFrame - this.retainFrames
    for (const f of this.localByFrame.keys()) {
      if (f < cutoff) this.localByFrame.delete(f)
    }
    for (const f of this.pendingRemote.keys()) {
      if (f < cutoff) this.pendingRemote.delete(f)
    }
  }
}
