// Joiner-side watchdog for "host-state has stopped landing". The host
// streams MSG_HOST_STATE every simulation tick on the unordered input
// channel; if the joiner's view falls silent for too long during a
// running round, the joiner is now disconnected and renders frozen
// state forever. This watchdog turns silence into actionable events:
//
//   - First stall (no host-state for stallMs) -> 'host-state-stalled'
//     so the UI can show a "lost connection" toast.
//   - Three stalls within evictionWindowMs -> 'peer-desync' so the
//     joiner can route to the existing host-gone path.
//
// Pure timer logic; net.ts owns the side effects (event emission,
// signaling teardown).

export interface HostStateWatchdogOptions {
  stallMs?: number
  evictionWindowMs?: number
  evictionThreshold?: number
  // Test seam: override the clock so virtual-timer tests can match
  // recorded stall timestamps against their fake `now`.
  now?: () => number
}

export type WatchdogEvent =
  | { kind: 'host-state-stalled' }
  | { kind: 'peer-desync' }

export class HostStateWatchdog {
  private readonly stallMs: number
  private readonly evictionWindowMs: number
  private readonly evictionThreshold: number
  private readonly now: () => number
  private stallTimestamps: number[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private listener: ((event: WatchdogEvent) => void) | null = null

  constructor(opts: HostStateWatchdogOptions = {}) {
    this.stallMs = opts.stallMs ?? 2000
    this.evictionWindowMs = opts.evictionWindowMs ?? 5000
    this.evictionThreshold = opts.evictionThreshold ?? 3
    this.now = opts.now ?? (() => Date.now())
  }

  setListener(fn: (event: WatchdogEvent) => void): void {
    this.listener = fn
  }

  // Called when MSG_HOST_STATE lands on the joiner. Resets the stall
  // timer; the next stall fires `stallMs` after the latest tick.
  noteHostStateApplied(): void {
    this.armTimer()
  }

  // Start watching. Call when the round transitions to running.
  start(): void {
    this.armTimer()
  }

  // Stop watching. Call when the round ends or the joiner leaves.
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.stallTimestamps = []
  }

  // Test seam: simulate the timer firing now.
  __fireForTest(now: number = Date.now()): void {
    this.onStall(now)
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.onStall(this.now()), this.stallMs)
  }

  private onStall(now: number): void {
    this.stallTimestamps.push(now)
    const cutoff = now - this.evictionWindowMs
    this.stallTimestamps = this.stallTimestamps.filter(t => t >= cutoff)
    this.listener?.({ kind: 'host-state-stalled' })
    if (this.stallTimestamps.length >= this.evictionThreshold) {
      this.listener?.({ kind: 'peer-desync' })
      this.stop()
      return
    }
    this.armTimer()
  }
}
