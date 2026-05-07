import { describe, expect, test } from 'bun:test'
import {
  canStartRoundFromState,
  peerOwnsPlayerIdFromRoster,
} from '../src/net-guards'

describe('peerOwnsPlayerIdFromRoster', () => {
  test('allows a local peer to submit only local player ids', () => {
    const remote = new Map([['joiner-a', ['blue']]])

    expect(peerOwnsPlayerIdFromRoster(remote, 'host', ['red'], 'host', 'red')).toBe(true)
    expect(peerOwnsPlayerIdFromRoster(remote, 'host', ['red'], 'host', 'blue')).toBe(false)
  })

  test('allows a remote peer to submit only assigned player ids', () => {
    const remote = new Map([['joiner-a', ['blue']]])

    expect(peerOwnsPlayerIdFromRoster(remote, 'host', ['red'], 'joiner-a', 'blue')).toBe(true)
    expect(peerOwnsPlayerIdFromRoster(remote, 'host', ['red'], 'joiner-a', 'red')).toBe(false)
  })

  test('denies known peers with no claimed players', () => {
    const remote = new Map([['joiner-a', []]])

    expect(peerOwnsPlayerIdFromRoster(remote, 'host', ['red'], 'joiner-a', 'red')).toBe(false)
    expect(peerOwnsPlayerIdFromRoster(remote, 'host', ['red'], 'joiner-a', 'blue')).toBe(false)
  })

  test('allows unknown peers during early handshake', () => {
    const remote = new Map([['joiner-a', ['blue']]])

    expect(peerOwnsPlayerIdFromRoster(remote, 'host', ['red'], 'joiner-b', 'blue')).toBe(true)
  })
})

describe('canStartRoundFromState', () => {
  test('allows host-only split keyboard when two local players are active', () => {
    expect(canStartRoundFromState(true, ['red', 'blue'], new Map(), new Map())).toBe(true)
  })

  test('requires at least two claimed players', () => {
    expect(canStartRoundFromState(true, ['red'], new Map(), new Map())).toBe(false)
  })

  test('requires claimed remote peers to have both channels open', () => {
    const remote = new Map([['joiner-a', ['blue']]])

    expect(canStartRoundFromState(true, ['red'], remote, new Map())).toBe(false)
    expect(canStartRoundFromState(true, ['red'], remote, new Map([
      ['joiner-a', { controlOpen: true, inputOpen: false }],
    ]))).toBe(false)
    expect(canStartRoundFromState(true, ['red'], remote, new Map([
      ['joiner-a', { controlOpen: true, inputOpen: true }],
    ]))).toBe(true)
  })

  test('does not block on connected peers with no claimed players', () => {
    const remote = new Map([['joiner-a', []]])
    const states = new Map([['joiner-a', { controlOpen: false, inputOpen: false }]])

    expect(canStartRoundFromState(true, ['red', 'blue'], remote, states)).toBe(true)
  })

  test('joiners can never start the authoritative round', () => {
    expect(canStartRoundFromState(false, ['blue'], new Map([['host', ['red']]]), new Map())).toBe(false)
  })
})
