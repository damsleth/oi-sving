// Dev orchestrator. Runs the static + signaling server, the JS rebuilder,
// and the CSS rebuilder side by side so one terminal kicks off the whole
// hot-reload loop. The server is started with OISVING_DEV=1 so it watches
// dist/ and pushes SSE 'reload' events to the browser; the JS bundler
// emits __DEV__=true so src/dev-reload.ts subscribes and reloads on those
// events. CSS rebuilds land in dist/css/main.css, which the same dist/
// watcher picks up.

import { spawn, type Subprocess } from 'bun'

const procs: Subprocess[] = [
  spawn({
    cmd: ['bun', 'run', 'server/signaling-server.ts'],
    env: { ...process.env, OISVING_DEV: '1' },
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  spawn({
    cmd: [
      'bun', 'build', 'src/main.ts',
      '--outfile=dist/js/oisving.min.js',
      '--target=browser',
      '--sourcemap=linked',
      '--define', '__DEV__=true',
      '--watch',
    ],
    env: { ...process.env, NODE_ENV: 'development' },
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  spawn({
    cmd: ['bun', 'x', 'sass', 'scss/main.scss', 'dist/css/main.css', '--watch', '--no-source-map', '--quiet-deps'],
    stdout: 'inherit',
    stderr: 'inherit',
  }),
]

const shutdown = () => {
  for (const p of procs) {
    try { p.kill() } catch { /* */ }
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// If any child exits on its own, take the rest down so the user isn't
// left with a half-running dev environment.
await Promise.race(procs.map(p => p.exited))
shutdown()
