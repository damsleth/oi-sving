// One-shot "Starting in N..." countdown. Kept free of DOM and Game
// state so the race between the timer and a manual round start can be
// tested: whoever starts the round first must cancel the other path.

export interface StartCountdownHooks {
  onTick: (remaining: number) => void
  onDone: () => void
}

export interface StartCountdownTimers {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: any) => void
}

export class StartCountdown {
  private handle: unknown = null
  private active = false

  constructor(
    private readonly timers: StartCountdownTimers = {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h),
    },
  ) {}

  isPending(): boolean {
    return this.active
  }

  // Returns false when a countdown is already running, so a repeated
  // start request can't stack a second timer chain.
  start(seconds: number, hooks: StartCountdownHooks): boolean {
    if (this.active) return false
    this.active = true
    let remaining = seconds
    hooks.onTick(remaining)
    const tick = () => {
      remaining--
      if (remaining > 0) {
        hooks.onTick(remaining)
        this.handle = this.timers.setTimeout(tick, 1000)
      } else {
        this.handle = null
        this.active = false
        hooks.onDone()
      }
    }
    this.handle = this.timers.setTimeout(tick, 1000)
    return true
  }

  // Returns true if a pending countdown was actually cancelled.
  cancel(): boolean {
    if (!this.active) return false
    this.active = false
    if (this.handle !== null) this.timers.clearTimeout(this.handle)
    this.handle = null
    return true
  }
}
