// Dev-only auto-reload bridge. Subscribes to /__reload (SSE) and reloads
// the page on 'reload' events. __DEV__ is replaced at bundle time via
// `bun build --define __DEV__=...`, so this entire block is dead-code
// eliminated in production builds. The server only answers /__reload
// when started with OISVING_DEV=1, so nothing else need gate it.

declare const __DEV__: boolean

if (__DEV__) {
  if (typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
    try {
      const es = new EventSource('/__reload')
      es.addEventListener('reload', () => location.reload())
    } catch { /* */ }
  }
}
