// Pure validation helpers for host-side claim/release. Extracted from
// net.ts so the decision logic can be tested without booting the
// WebRTC + signaling singletons. The host module owns the side
// effects (mutating roster maps, emitting events, broadcasting); these
// helpers just compute what the decision should be.

export type ClaimDecisionKind =
  | 'reject-not-allowed'
  | 'reject-already-taken'
  | 'accept'

export interface ClaimDecision {
  kind: ClaimDecisionKind
  playerId: string
  isLocal: boolean
}

export interface DecideClaimInput {
  fromPeerId: string
  localPeerId: string
  playerId: string
  allowedPlayerIds: ReadonlySet<string>
  localPlayerIds: readonly string[]
  remotePlayerIdsByPeer: ReadonlyMap<string, readonly string[]>
}

export function decideClaim(opts: DecideClaimInput): ClaimDecision {
  const isLocal = opts.fromPeerId === opts.localPeerId
  if (!opts.allowedPlayerIds.has(opts.playerId)) {
    return { kind: 'reject-not-allowed', playerId: opts.playerId, isLocal }
  }
  if (opts.localPlayerIds.includes(opts.playerId)) {
    return { kind: 'reject-already-taken', playerId: opts.playerId, isLocal }
  }
  for (const ids of opts.remotePlayerIdsByPeer.values()) {
    if (ids.includes(opts.playerId)) {
      return { kind: 'reject-already-taken', playerId: opts.playerId, isLocal }
    }
  }
  return { kind: 'accept', playerId: opts.playerId, isLocal }
}

export type ReleaseDecisionKind = 'no-op' | 'released'

export interface ReleaseDecision {
  kind: ReleaseDecisionKind
  playerId: string
  isLocal: boolean
}

export interface DecideReleaseInput {
  fromPeerId: string
  localPeerId: string
  playerId: string
  localPlayerIds: readonly string[]
  remotePlayerIdsByPeer: ReadonlyMap<string, readonly string[]>
}

export function decideRelease(opts: DecideReleaseInput): ReleaseDecision {
  const isLocal = opts.fromPeerId === opts.localPeerId
  if (isLocal) {
    if (opts.localPlayerIds.includes(opts.playerId)) {
      return { kind: 'released', playerId: opts.playerId, isLocal: true }
    }
    return { kind: 'no-op', playerId: opts.playerId, isLocal: true }
  }
  const peerIds = opts.remotePlayerIdsByPeer.get(opts.fromPeerId)
  if (peerIds && peerIds.includes(opts.playerId)) {
    return { kind: 'released', playerId: opts.playerId, isLocal: false }
  }
  return { kind: 'no-op', playerId: opts.playerId, isLocal: false }
}
