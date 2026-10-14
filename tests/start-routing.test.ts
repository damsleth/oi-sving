import { describe, expect, test } from 'bun:test'
import { routeHostStartRequest, routeJoinerGameSpace, type GamePhase } from '../src/start-routing'

const idle: GamePhase = {
  gameScreenActive: true,
  countdownPending: false,
  isRoundStarted: false,
  isRunning: false,
  isPaused: false,
  isGameOver: false,
}

describe('routeHostStartRequest', () => {
  test('menu screen: menu start', () => {
    expect(routeHostStartRequest({ ...idle, gameScreenActive: false })).toBe('menu-start')
  })
  test('game screen between rounds: round start', () => {
    expect(routeHostStartRequest(idle)).toBe('round-start')
  })
  test.each([
    ['running', { isRunning: true, isRoundStarted: true }],
    ['round started', { isRoundStarted: true }],
    ['paused', { isPaused: true }],
    ['countdown', { countdownPending: true }],
    ['game over', { isGameOver: true }],
  ])('game screen %s: ignore', (_name, over) => {
    expect(routeHostStartRequest({ ...idle, ...over })).toBe('ignore')
  })
})

describe('routeJoinerGameSpace', () => {
  const master = { ...idle, isMaster: true, canStart: true }
  test('master between rounds requests a start', () => {
    expect(routeJoinerGameSpace(master)).toBe('request')
  })
  test('non-master is a no-op', () => {
    expect(routeJoinerGameSpace({ ...master, isMaster: false })).toBe('noop')
  })
  test('master without enough players is a no-op', () => {
    expect(routeJoinerGameSpace({ ...master, canStart: false })).toBe('noop')
  })
  test.each([
    ['running', { isRunning: true }],
    ['paused', { isPaused: true }],
    ['game over', { isGameOver: true }],
    ['countdown', { countdownPending: true }],
  ])('master while %s is a no-op', (_name, over) => {
    expect(routeJoinerGameSpace({ ...master, ...over })).toBe('noop')
  })
})
