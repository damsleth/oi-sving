// Per-peer reconnect controller. Pure state machine over WebRTC
// connection-state transitions. Owns:
//
//   - Debounce: a `disconnected` state often resolves on its own
//     within a second when ICE momentarily can't probe. Wait
//     `disconnectDebounceMs` before initiating restart.
//   - Attempts: cap restarts at `maxAttemptsPerWindow` inside
//     `attemptWindowMs` so a flapping connection doesn't pin the CPU
//     re-offering forever.
//
// Caller (net.ts) wires this to actual WebRTC operations: when
// `decision === 'restart-ice'`, call pc.restartIce() and create a
// fresh offer; when `decision === 'give-up'`, route the peer
// through the existing peer-left / host-gone path.

export type WebRtcConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed'

export type ReconnectDecision =
  | { kind: 'idle' }
  | { kind: 'wait-debounce' }
  | { kind: 'restart-ice' }
  | { kind: 'give-up' }

export interface PeerReconnectControllerOptions {
  disconnectDebounceMs?: number
  attemptWindowMs?: number
  maxAttemptsPerWindow?: number
  now?: () => number
}

export class PeerReconnectController {
  private readonly disconnectDebounceMs: number
  private readonly attemptWindowMs: number
  private readonly maxAttempts: number
  private readonly now: () => number
  private attempts: number[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastState: WebRtcConnectionState = 'new'
  private listener: ((decision: ReconnectDecision) => void) | null = null

  constructor(opts: PeerReconnectControllerOptions = {}) {
    this.disconnectDebounceMs = opts.disconnectDebounceMs ?? 1000
    this.attemptWindowMs = opts.attemptWindowMs ?? 5000
    this.maxAttempts = opts.maxAttemptsPerWindow ?? 3
    this.now = opts.now ?? (() => Date.now())
  }

  setListener(fn: (decision: ReconnectDecision) => void): void {
    this.listener = fn
  }

  // Drive from RTCPeerConnection.connectionstatechange.
  noteState(state: WebRtcConnectionState): void {
    const prev = this.lastState
    this.lastState = state

    // Healthy transition cancels any pending restart but does NOT
    // clear attempts — a flapping connection that keeps blinking
    // through `connected` should still hit the give-up path. The
    // sliding window evicts stale attempts naturally.
    if (state === 'connected') {
      this.cancelDebounce()
      // Only surface 'idle' on the first stable connect from a
      // non-connected state, so a flap doesn't flood listeners with
      // identical idle decisions.
      if (prev !== 'connected') this.listener?.({ kind: 'idle' })
      return
    }

    if (state === 'failed') {
      // Failed is past disconnected; skip the debounce and try
      // immediately, gated on the attempt budget.
      this.cancelDebounce()
      this.tryRestart()
      return
    }

    if (state === 'disconnected' && prev !== 'disconnected') {
      this.armDebounce()
      this.listener?.({ kind: 'wait-debounce' })
      return
    }

    if (state === 'closed') {
      this.cancelDebounce()
      this.attempts = []
    }
  }

  // Tear down. Caller invokes from leaveRoom and on permanent giveup.
  stop(): void {
    this.cancelDebounce()
    this.attempts = []
    this.listener = null
  }

  private armDebounce(): void {
    this.cancelDebounce()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      // Only restart if we're still in disconnected. A `connected`
      // transition during the debounce window cancels via noteState.
      if (this.lastState === 'disconnected') this.tryRestart()
    }, this.disconnectDebounceMs)
  }

  private cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private tryRestart(): void {
    const t = this.now()
    const cutoff = t - this.attemptWindowMs
    this.attempts = this.attempts.filter(s => s >= cutoff)
    if (this.attempts.length >= this.maxAttempts) {
      this.listener?.({ kind: 'give-up' })
      return
    }
    this.attempts.push(t)
    this.listener?.({ kind: 'restart-ice' })
  }
}
