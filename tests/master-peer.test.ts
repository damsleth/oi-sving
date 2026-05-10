// computeMasterPeerId: which peer is authorized to start a round.
// Pure function over the roster snapshot. Verifies the rule: host wins
// if it has any local players; otherwise first joiner with a claimed
// color (insertion order); empty returns ''.

import { describe, expect, test } from 'bun:test'
import { computeMasterPeerId, type RosterSnapshot } from '../src/roster'

function snap(over: Partial<RosterSnapshot>): RosterSnapshot {
  return {
    hostPeerId: 'host',
    hostPlayerIds: [],
    joiners: [],
    ...over,
  }
}

describe('computeMasterPeerId', () => {
  test('host with claimed players wins regardless of joiner order', () => {
    expect(computeMasterPeerId(snap({
      hostPeerId: 'host',
      hostPlayerIds: ['red'],
      joiners: [
        { peerId: 'p1', playerIds: ['blue'] },
        { peerId: 'p2', playerIds: ['green'] },
      ],
    }))).toBe('host')
  })

  test('host with no claimed players: first joiner with a claim is master', () => {
    expect(computeMasterPeerId(snap({
      hostPeerId: 'host',
      hostPlayerIds: [],
      joiners: [
        { peerId: 'p1', playerIds: ['blue'] },
        { peerId: 'p2', playerIds: ['green'] },
      ],
    }))).toBe('p1')
  })

  test('skips joiners with no claims to find the first one with one', () => {
    expect(computeMasterPeerId(snap({
      hostPeerId: 'host',
      hostPlayerIds: [],
      joiners: [
        { peerId: 'p1', playerIds: [] },
        { peerId: 'p2', playerIds: ['blue'] },
        { peerId: 'p3', playerIds: ['green'] },
      ],
    }))).toBe('p2')
  })

  test('empty room: returns empty string (no candidate)', () => {
    expect(computeMasterPeerId(snap({
      hostPeerId: 'host',
      hostPlayerIds: [],
      joiners: [],
    }))).toBe('')
  })

  test('host present but no claims anywhere: returns empty', () => {
    expect(computeMasterPeerId(snap({
      hostPeerId: 'host',
      hostPlayerIds: [],
      joiners: [
        { peerId: 'p1', playerIds: [] },
        { peerId: 'p2', playerIds: [] },
      ],
    }))).toBe('')
  })

  test('null/undefined snapshot: returns empty', () => {
    expect(computeMasterPeerId(null as unknown as RosterSnapshot)).toBe('')
    expect(computeMasterPeerId(snap({ hostPeerId: '' }))).toBe('')
  })

  test('host has 0 local players, then a player claims red on host: master flips to host', () => {
    const before = snap({
      hostPeerId: 'host',
      hostPlayerIds: [],
      joiners: [{ peerId: 'p1', playerIds: ['blue'] }],
    })
    const after = snap({
      hostPeerId: 'host',
      hostPlayerIds: ['red'],
      joiners: [{ peerId: 'p1', playerIds: ['blue'] }],
    })
    expect(computeMasterPeerId(before)).toBe('p1')
    expect(computeMasterPeerId(after)).toBe('host')
  })
})
