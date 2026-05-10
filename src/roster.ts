// Roster reconciliation. Pulled out of net.ts so the diff logic — the
// thing that decides which player-joined / player-left events fire when
// the host broadcasts a new authoritative snapshot — is a pure function
// over (previous state, snapshot, local identity) and can be tested
// without booting WebRTC.
//
// The host owns the authoritative roster. Joiners overwrite their local
// view with each broadcast snapshot. The diff catches:
//   - colors that another peer just claimed (remote player-joined)
//   - colors that vanished from another peer (remote player-left)
//   - colors the host granted to me that weren't in my view (local
//     player-joined — the optimistic-claim confirmation path)
//   - colors the host revoked from me (local player-left — the
//     optimistic-claim rejection path)

export interface RosterSnapshot {
  hostPeerId: string
  hostPlayerIds: string[]
  hostAddress?: string | null
  hostHostname?: string | null
  joiners: Array<{ peerId: string; playerIds: string[]; address?: string | null; hostname?: string | null }>
}

export interface RosterDiffEvent {
  type: 'player-joined' | 'player-left'
  peerId: string
  playerId: string
  isLocal: boolean
}

export interface RosterDiffInput {
  snap: RosterSnapshot
  previousRemote: Map<string, string[]>
  previousLocal: string[]
  localPeerId: string
  isHost: boolean
}

export interface RosterDiffOutput {
  newRemote: Map<string, string[]>
  newLocal: string[]
  newHostPeerId: string | null
  events: RosterDiffEvent[]
}

export function diffRosterSnapshot(input: RosterDiffInput): RosterDiffOutput {
  const { snap, previousRemote, previousLocal, localPeerId, isHost } = input

  const newRemote = new Map<string, string[]>()
  let newLocal: string[] = previousLocal
  let newHostPeerId: string | null = null

  if (snap.hostPeerId && snap.hostPeerId !== localPeerId) {
    newRemote.set(snap.hostPeerId, [...(snap.hostPlayerIds ?? [])])
    newHostPeerId = snap.hostPeerId
  }

  let localFoundInJoiners = false
  for (const j of snap.joiners ?? []) {
    if (j.peerId === localPeerId) {
      newLocal = [...(j.playerIds ?? [])]
      localFoundInJoiners = true
    } else {
      newRemote.set(j.peerId, [...(j.playerIds ?? [])])
    }
  }

  // If the host's snapshot doesn't list this peer at all, the joiner's
  // local roster collapses. Hosts always have local truth so we don't
  // touch their localPlayerIds in that case.
  if (!localFoundInJoiners && !isHost) {
    newLocal = []
  }

  const events: RosterDiffEvent[] = []
  const previousRemoteFlat = new Set([...previousRemote.values()].flat())
  const currentRemoteFlat = new Set([...newRemote.values()].flat())
  for (const id of previousRemoteFlat) {
    if (!currentRemoteFlat.has(id)) {
      events.push({ type: 'player-left', peerId: '', playerId: id, isLocal: false })
    }
  }
  for (const id of currentRemoteFlat) {
    if (!previousRemoteFlat.has(id)) {
      events.push({ type: 'player-joined', peerId: '', playerId: id, isLocal: false })
    }
  }
  for (const id of previousLocal) {
    if (!newLocal.includes(id)) {
      events.push({ type: 'player-left', peerId: localPeerId, playerId: id, isLocal: true })
    }
  }
  for (const id of newLocal) {
    if (!previousLocal.includes(id)) {
      events.push({ type: 'player-joined', peerId: localPeerId, playerId: id, isLocal: true })
    }
  }

  return { newRemote, newLocal, newHostPeerId, events }
}

// "Game master" computation. The peer authorized to trigger a round
// start. Rule:
//   - If the host has any claimed players, the host is master. (A
//     desktop running both the server and a local color-picker stays
//     in charge of the lobby.)
//   - Otherwise, the first joiner (in roster.joiners insertion order)
//     who has claimed at least one player. Headless `--host` server
//     scenarios depend on this branch so the lobby can still progress.
//   - Returns '' when no candidate qualifies (empty room, host present
//     but no one has claimed yet). Caller treats '' as "nobody can
//     start yet".
export function computeMasterPeerId(snap: RosterSnapshot): string {
  if (!snap || !snap.hostPeerId) return ''
  if (Array.isArray(snap.hostPlayerIds) && snap.hostPlayerIds.length > 0) {
    return snap.hostPeerId
  }
  for (const j of snap.joiners ?? []) {
    if (Array.isArray(j.playerIds) && j.playerIds.length > 0 && j.peerId) return j.peerId
  }
  return ''
}
