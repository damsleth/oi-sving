// Joiner-side master determination. A joiner must derive the master from
// the host's last applied MSG_ROSTER snapshot (host-authoritative order),
// never from its own local view, which only lists itself.

import { describe, expect, test } from 'bun:test'
import { resolveMasterPeerId, type RosterSnapshot } from '../src/roster'

const hostSnap: RosterSnapshot = {
  hostPeerId: 'host',
  hostPlayerIds: [],
  joiners: [
    { peerId: 'A', playerIds: ['red'] },
    { peerId: 'B', playerIds: ['blue'] },
  ],
}

describe('resolveMasterPeerId', () => {
  test('joiner: host snapshot order [A, B] makes A master, B is not', () => {
    // Local signaling order [B, A] is deliberately different and must be ignored.
    const localView = { hostPeerId: 'host', hostPlayerIds: [], joiners: [{ peerId: 'B', playerIds: ['blue'] }] }
    expect(resolveMasterPeerId({ isHost: false, liveSnapshot: localView, lastHostSnapshot: hostSnap })).toBe('A')
  })

  test('joiner without a host snapshot yet: nobody is master', () => {
    const localView = { hostPeerId: 'host', hostPlayerIds: [], joiners: [{ peerId: 'B', playerIds: ['blue'] }] }
    expect(resolveMasterPeerId({ isHost: false, liveSnapshot: localView, lastHostSnapshot: null })).toBe('')
  })

  test('host uses its live snapshot', () => {
    expect(resolveMasterPeerId({ isHost: true, liveSnapshot: hostSnap, lastHostSnapshot: null })).toBe('A')
  })
})
