// Per-peer state-hash mismatch tracker for the host. The host receives
// MSG_STATE_HASH from each joiner; on mismatch it pushes a fresh
// authoritative MSG_HOST_STATE so the joiner can re-sync. If the same
// joiner still mismatches `maxMismatches` times within `windowMs`,
// the host has lost confidence in their view and evicts that joiner
// only - the round continues for the rest.
//
// Pure state-machine: no protocol, no DOM. The caller (net.ts) is
// responsible for the actual force-broadcast and slot teardown when
// the tracker says so.

export interface MismatchOptions {
  windowMs?: number
  maxMismatches?: number
  now?: () => number
}

export type MismatchOutcome =
  | { kind: 'resync' }
  | { kind: 'evict' }

export class HostMismatchTracker {
  private readonly windowMs: number
  private readonly maxMismatches: number
  private readonly now: () => number
  private timestampsByPeer = new Map<string, number[]>()

  constructor(opts: MismatchOptions = {}) {
    this.windowMs = opts.windowMs ?? 5000
    this.maxMismatches = opts.maxMismatches ?? 3
    this.now = opts.now ?? (() => Date.now())
  }

  // Record a mismatch for `peerId`. Returns 'resync' for the first
  // (and second...) mismatches inside the window, 'evict' once the
  // count crosses the threshold.
  noteMismatch(peerId: string): MismatchOutcome {
    const t = this.now()
    const cutoff = t - this.windowMs
    const list = (this.timestampsByPeer.get(peerId) ?? []).filter(s => s >= cutoff)
    list.push(t)
    this.timestampsByPeer.set(peerId, list)
    return list.length >= this.maxMismatches ? { kind: 'evict' } : { kind: 'resync' }
  }

  // Reset on a successful resync, peer leave, or round end.
  forget(peerId: string): void {
    this.timestampsByPeer.delete(peerId)
  }

  clear(): void {
    this.timestampsByPeer.clear()
  }

  // Test introspection.
  countWithinWindow(peerId: string): number {
    const cutoff = this.now() - this.windowMs
    return (this.timestampsByPeer.get(peerId) ?? []).filter(s => s >= cutoff).length
  }
}
