// Tests for the host-side claim/release validation logic. These pin
// the rules that today live in src/host-roster-validator.ts and are
// applied (with side effects) from net.ts:
//   - color outside the allowed list is rejected
//   - color already taken (by host or any joiner) is rejected
//   - successful claim flagged as local vs remote based on fromPeerId
//   - release of a color the peer doesn't own is no-op
//   - release of a color the peer does own is released

import { describe, expect, test } from 'bun:test'
import { decideClaim, decideRelease } from '../src/host-roster-validator'

const ALLOWED = new Set(['red', 'orange', 'green', 'blue', 'purple', 'pink'])
const HOST = 'host-peer'
const JOINER_A = 'joiner-a'
const JOINER_B = 'joiner-b'

describe('decideClaim', () => {
  test('rejects a color outside the allowed list', () => {
    const out = decideClaim({
      fromPeerId: JOINER_A,
      localPeerId: HOST,
      playerId: 'teal',
      allowedPlayerIds: ALLOWED,
      localPlayerIds: [],
      remotePlayerIdsByPeer: new Map(),
    })
    expect(out.kind).toBe('reject-not-allowed')
    expect(out.isLocal).toBe(false)
  })

  test('rejects a color already claimed by the host', () => {
    const out = decideClaim({
      fromPeerId: JOINER_A,
      localPeerId: HOST,
      playerId: 'red',
      allowedPlayerIds: ALLOWED,
      localPlayerIds: ['red'],
      remotePlayerIdsByPeer: new Map(),
    })
    expect(out.kind).toBe('reject-already-taken')
  })

  test('rejects a color already claimed by another joiner', () => {
    const out = decideClaim({
      fromPeerId: JOINER_B,
      localPeerId: HOST,
      playerId: 'blue',
      allowedPlayerIds: ALLOWED,
      localPlayerIds: ['red'],
      remotePlayerIdsByPeer: new Map([[JOINER_A, ['blue']]]),
    })
    expect(out.kind).toBe('reject-already-taken')
  })

  test('accepts a remote claim and flags isLocal=false', () => {
    const out = decideClaim({
      fromPeerId: JOINER_A,
      localPeerId: HOST,
      playerId: 'green',
      allowedPlayerIds: ALLOWED,
      localPlayerIds: ['red'],
      remotePlayerIdsByPeer: new Map([[JOINER_A, []]]),
    })
    expect(out).toEqual({ kind: 'accept', playerId: 'green', isLocal: false })
  })

  test('accepts a host self-claim and flags isLocal=true', () => {
    const out = decideClaim({
      fromPeerId: HOST,
      localPeerId: HOST,
      playerId: 'orange',
      allowedPlayerIds: ALLOWED,
      localPlayerIds: ['red'],
      remotePlayerIdsByPeer: new Map(),
    })
    expect(out).toEqual({ kind: 'accept', playerId: 'orange', isLocal: true })
  })
})

describe('decideRelease', () => {
  test('no-op when the local host releases a color it does not own', () => {
    const out = decideRelease({
      fromPeerId: HOST,
      localPeerId: HOST,
      playerId: 'red',
      localPlayerIds: ['blue'],
      remotePlayerIdsByPeer: new Map(),
    })
    expect(out).toEqual({ kind: 'no-op', playerId: 'red', isLocal: true })
  })

  test('release when the local host owns the color', () => {
    const out = decideRelease({
      fromPeerId: HOST,
      localPeerId: HOST,
      playerId: 'red',
      localPlayerIds: ['red'],
      remotePlayerIdsByPeer: new Map(),
    })
    expect(out).toEqual({ kind: 'released', playerId: 'red', isLocal: true })
  })

  test('no-op when a joiner releases a color it does not own', () => {
    const out = decideRelease({
      fromPeerId: JOINER_A,
      localPeerId: HOST,
      playerId: 'blue',
      localPlayerIds: [],
      remotePlayerIdsByPeer: new Map([[JOINER_A, ['green']]]),
    })
    expect(out).toEqual({ kind: 'no-op', playerId: 'blue', isLocal: false })
  })

  test('release when the joiner owns the color', () => {
    const out = decideRelease({
      fromPeerId: JOINER_A,
      localPeerId: HOST,
      playerId: 'blue',
      localPlayerIds: [],
      remotePlayerIdsByPeer: new Map([[JOINER_A, ['blue']]]),
    })
    expect(out).toEqual({ kind: 'released', playerId: 'blue', isLocal: false })
  })

  test('release does not cross-bleed across joiners', () => {
    // Joiner A asks to release 'blue' but only Joiner B owns it. Should
    // be a no-op against A, not pull blue out of B's slot.
    const out = decideRelease({
      fromPeerId: JOINER_A,
      localPeerId: HOST,
      playerId: 'blue',
      localPlayerIds: [],
      remotePlayerIdsByPeer: new Map([[JOINER_A, []], [JOINER_B, ['blue']]]),
    })
    expect(out.kind).toBe('no-op')
  })
})
