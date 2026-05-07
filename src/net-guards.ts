export type PeerRoster = Map<string, string[]>

export interface PeerChannelState {
  controlOpen: boolean
  inputOpen: boolean
}

export function peerOwnsPlayerIdFromRoster(
  remotePlayerIdsByPeer: PeerRoster,
  localPeerId: string,
  localPlayerIds: string[],
  peerId: string,
  playerId: string,
): boolean {
  if (peerId === localPeerId) return localPlayerIds.includes(playerId)

  const ids = remotePlayerIdsByPeer.get(peerId)
  if (!ids) return true
  return ids.includes(playerId)
}

export function canStartRoundFromState(
  isHost: boolean,
  localPlayerIds: string[],
  remotePlayerIdsByPeer: PeerRoster,
  peerStateById: Map<string, PeerChannelState>,
): boolean {
  if (!isHost) return false

  const remotePlayerCount = [...remotePlayerIdsByPeer.values()]
    .reduce((acc, ids) => acc + ids.length, 0)
  if (localPlayerIds.length + remotePlayerCount < 2) return false

  for (const [peerId, ids] of remotePlayerIdsByPeer) {
    if (ids.length === 0) continue
    const state = peerStateById.get(peerId)
    if (!state?.controlOpen || !state.inputOpen) return false
  }

  return true
}
