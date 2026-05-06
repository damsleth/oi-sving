// Tests for the roster reconciliation diff. The diff is the thing that
// decides which player-joined / player-left events fire when the host
// broadcasts a new authoritative snapshot — wrong diffs lead to
// menu colors stuck as "taken" after a peer left, or to a joiner
// confidently keeping a color the host actually rejected.

import { describe, expect, test } from 'bun:test'
import { diffRosterSnapshot, type RosterSnapshot } from '../src/roster'

const HOST_ID = 'host-peer'
const ME = 'me-peer'
const OTHER = 'other-peer'

const emptyPrev = (): { previousRemote: Map<string, string[]>; previousLocal: string[] } => ({
  previousRemote: new Map<string, string[]>(),
  previousLocal: [],
})

describe('diffRosterSnapshot — initial reconcile (joiner)', () => {
  test('host-only snapshot lands the host as the only remote peer', () => {
    const snap: RosterSnapshot = { hostPeerId: HOST_ID, hostPlayerIds: ['red'], joiners: [] }
    const out = diffRosterSnapshot({
      snap,
      ...emptyPrev(),
      localPeerId: ME,
      isHost: false,
    })

    expect(out.newHostPeerId).toBe(HOST_ID)
    expect(Object.fromEntries(out.newRemote)).toEqual({ [HOST_ID]: ['red'] })
    expect(out.newLocal).toEqual([])
    // Host's red is a new remote color → player-joined (remote).
    expect(out.events).toEqual([
      { type: 'player-joined', peerId: '', playerId: 'red', isLocal: false },
    ])
  })

  test('the joiner that this peer IS gets pulled into newLocal, not newRemote', () => {
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: ['red'],
      joiners: [{ peerId: ME, playerIds: ['blue'] }],
    }
    const out = diffRosterSnapshot({
      snap,
      ...emptyPrev(),
      localPeerId: ME,
      isHost: false,
    })

    expect(out.newLocal).toEqual(['blue'])
    expect(Object.fromEntries(out.newRemote)).toEqual({ [HOST_ID]: ['red'] })
    // Two new arrivals from this peer's POV: host's red (remote) and
    // the host's confirmation that I now own blue (local).
    expect(out.events).toContainEqual({ type: 'player-joined', peerId: '', playerId: 'red', isLocal: false })
    expect(out.events).toContainEqual({ type: 'player-joined', peerId: ME, playerId: 'blue', isLocal: true })
  })

  test('host-broadcast snapshot from the host\'s own perspective has empty newRemote', () => {
    // When the host applies its OWN snapshot (the local emit path in
    // broadcastRoster), hostPeerId equals localPeerId, so newRemote
    // should NOT contain the host's playerIds — those are local.
    const snap: RosterSnapshot = {
      hostPeerId: ME,
      hostPlayerIds: ['red'],
      joiners: [{ peerId: ME, playerIds: ['red'] }],
    }
    const out = diffRosterSnapshot({
      snap,
      ...emptyPrev(),
      localPeerId: ME,
      isHost: true,
    })
    expect(Object.fromEntries(out.newRemote)).toEqual({})
    expect(out.newLocal).toEqual(['red'])
  })
})

describe('diffRosterSnapshot — incremental updates', () => {
  test('a remote claim is surfaced as remote player-joined', () => {
    const previousRemote = new Map([[HOST_ID, ['red']]])
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: ['red'],
      joiners: [{ peerId: OTHER, playerIds: ['blue'] }],
    }
    const out = diffRosterSnapshot({
      snap,
      previousRemote,
      previousLocal: [],
      localPeerId: ME,
      isHost: false,
    })

    expect(out.events).toEqual([
      { type: 'player-joined', peerId: '', playerId: 'blue', isLocal: false },
    ])
  })

  test('a remote release is surfaced as remote player-left', () => {
    const previousRemote = new Map([[HOST_ID, ['red', 'orange']]])
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: ['red'],
      joiners: [],
    }
    const out = diffRosterSnapshot({
      snap,
      previousRemote,
      previousLocal: [],
      localPeerId: ME,
      isHost: false,
    })

    expect(out.events).toEqual([
      { type: 'player-left', peerId: '', playerId: 'orange', isLocal: false },
    ])
  })

  test('the host rejecting our local claim flips us back via local player-left', () => {
    // Optimistic UX: joiner activated 'green' locally and sent a claim.
    // Host roster comes back without 'green'. The diff must emit a
    // local player-left so the menu un-activates the color.
    const previousRemote = new Map([[HOST_ID, ['red']]])
    const previousLocal = ['green']
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: ['red'],
      joiners: [{ peerId: ME, playerIds: [] }],
    }
    const out = diffRosterSnapshot({
      snap,
      previousRemote,
      previousLocal,
      localPeerId: ME,
      isHost: false,
    })

    expect(out.newLocal).toEqual([])
    expect(out.events).toContainEqual({ type: 'player-left', peerId: ME, playerId: 'green', isLocal: true })
  })

  test('host accepting our local claim emits local player-joined', () => {
    // Joiner had no local ids, host roster comes back saying we now
    // own 'green'. The diff must emit a local player-joined so the
    // menu visually activates the color.
    const previousRemote = new Map([[HOST_ID, ['red']]])
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: ['red'],
      joiners: [{ peerId: ME, playerIds: ['green'] }],
    }
    const out = diffRosterSnapshot({
      snap,
      previousRemote,
      previousLocal: [],
      localPeerId: ME,
      isHost: false,
    })

    expect(out.newLocal).toEqual(['green'])
    expect(out.events).toContainEqual({ type: 'player-joined', peerId: ME, playerId: 'green', isLocal: true })
  })

  test('snapshot omitting this peer collapses the joiner\'s local roster', () => {
    // Host's snapshot doesn't list me at all (host-side rejection of
    // my entire participation, e.g. the host kicked me). Joiner's
    // local colors must drop and emit local player-left for each.
    const previousRemote = new Map([[HOST_ID, ['red']]])
    const previousLocal = ['blue', 'pink']
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: ['red'],
      joiners: [],
    }
    const out = diffRosterSnapshot({
      snap,
      previousRemote,
      previousLocal,
      localPeerId: ME,
      isHost: false,
    })

    expect(out.newLocal).toEqual([])
    expect(out.events).toContainEqual({ type: 'player-left', peerId: ME, playerId: 'blue', isLocal: true })
    expect(out.events).toContainEqual({ type: 'player-left', peerId: ME, playerId: 'pink', isLocal: true })
  })

  test('host self-applies do NOT collapse local roster (omit-implies-collapse is joiner-only)', () => {
    // The "snapshot omits this peer → collapse local" path was the
    // joiner-side host-rejected-me hammer. On the host, broadcastRoster
    // builds the snapshot from local truth so the host's own
    // localPlayerIds must be left alone even if joiners-only is empty.
    const previousLocal = ['red']
    const snap: RosterSnapshot = {
      hostPeerId: ME,
      hostPlayerIds: ['red'],
      joiners: [],
    }
    const out = diffRosterSnapshot({
      snap,
      ...emptyPrev(),
      previousLocal,
      localPeerId: ME,
      isHost: true,
    })

    expect(out.newLocal).toEqual(previousLocal)
  })
})

describe('diffRosterSnapshot — multi-peer diffs', () => {
  test('one new remote, one removed remote, on the same snapshot', () => {
    const previousRemote = new Map([
      [HOST_ID, ['red']],
      ['joiner-a', ['blue']],
    ])
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: ['red'],
      joiners: [
        { peerId: 'joiner-b', playerIds: ['green'] },
      ],
    }
    const out = diffRosterSnapshot({
      snap,
      previousRemote,
      previousLocal: [],
      localPeerId: ME,
      isHost: false,
    })

    // Blue left, green joined.
    expect(out.events).toContainEqual({ type: 'player-left', peerId: '', playerId: 'blue', isLocal: false })
    expect(out.events).toContainEqual({ type: 'player-joined', peerId: '', playerId: 'green', isLocal: false })
    expect(out.events.some(e => e.playerId === 'red')).toBe(false) // unchanged
  })

  test('a peer-id rename with the same playerIds emits no events', () => {
    // Edge case: peer A leaves and peer B claims the same color in
    // the same snapshot. From the player-color POV nothing changed,
    // so no remote player-joined/left fires.
    const previousRemote = new Map([['joiner-a', ['blue']]])
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: [],
      joiners: [{ peerId: 'joiner-b', playerIds: ['blue'] }],
    }
    const out = diffRosterSnapshot({
      snap,
      previousRemote,
      previousLocal: [],
      localPeerId: ME,
      isHost: false,
    })

    expect(out.events).toEqual([])
  })

  test('snapshot is idempotent: applying the same view twice emits nothing', () => {
    const remote = new Map([[HOST_ID, ['red']], ['joiner-a', ['blue']]])
    const snap: RosterSnapshot = {
      hostPeerId: HOST_ID,
      hostPlayerIds: ['red'],
      joiners: [
        { peerId: ME, playerIds: ['green'] },
        { peerId: 'joiner-a', playerIds: ['blue'] },
      ],
    }
    const out = diffRosterSnapshot({
      snap,
      previousRemote: remote,
      previousLocal: ['green'],
      localPeerId: ME,
      isHost: false,
    })

    expect(out.events).toEqual([])
  })
})
