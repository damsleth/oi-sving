export const WATCHDOG_EXIT_CODE = 124

let fired = false
export const watchdogFired = (): boolean => fired

// Bounds the whole e2e run so a stuck waitFor, CDP socket or teardown cannot
// hang the process. unref() so a pending timer never keeps Bun alive after a
// successful run, while still firing if something else holds the loop open.
export function startWatchdog(
  name: string,
  defaultMs: number,
  teardown: (exitCode: number) => Promise<void>,
  forceCleanup: () => void,
): void {
  const budgetMs = Number(process.env.E2E_WATCHDOG_MS ?? defaultMs)
  const timer = setTimeout(() => {
    fired = true
    console.error(`${name} watchdog expired after ${budgetMs}ms, tearing down`)
    // teardown itself can wedge (killProcess is bounded, other awaits are not),
    // so a hard fallback guarantees children and the profile dir are cleaned.
    const hard = setTimeout(() => {
      try { forceCleanup() } catch { /* */ }
      process.exit(WATCHDOG_EXIT_CODE)
    }, 8000)
    hard.unref()
    teardown(WATCHDOG_EXIT_CODE).catch(() => {
      try { forceCleanup() } catch { /* */ }
      process.exit(WATCHDOG_EXIT_CODE)
    })
  }, budgetMs)
  timer.unref()
}
