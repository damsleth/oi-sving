# Oi, Sving!

> _tl;dr - HTML5 multiplayer Achtung. Bun + TypeScript + PIXI in the browser, WebRTC datachannels for the gameplay path, a tiny LAN server for signaling. Single-player works. Network play is wired end-to-end and waiting on a real two-browser smoke test._

The name is a loose Norwegian-ish translation of the German _Achtung, die Kurve!_ - same "oh god, turn!" vibe, just more Bergen-on-a-Friday. Forked from [maechler/kurve](https://github.com/maechler/kurve), rebranded, fully ported to Bun + TypeScript, and rebuilt around a deterministic lockstep core so up to six peers can share an arena over LAN without a relay server.

## What's in the box

- A static browser game. No backend required to play single-player or split-keyboard.
- A Bun build that produces `dist/js/oisving.min.js` + `dist/css/main.css` + the static assets `index.html` already expects.
- A self-hostable LAN server (`server/signaling-server.ts`, runs on Bun) that does double duty: serves `index.html` over HTTP and brokers WebRTC SDP/ICE over WebSocket on the same port.
- A Cloudflare Worker + Durable Object stub (`server/signaling-worker.ts`, `signaling-room.ts`) for when you'd rather run signaling on the edge than on a laptop.
- A determinism harness so the lockstep tick stays honest (FNV-1a state-hash gossip, seeded Mulberry32 RNG, canonical arena dims).

## Requirements

- [Bun](https://bun.sh/) for everything - install, dev, build, tests, signaling executable.
- A modern browser with WebRTC datachannels. Anything Chromium-based or recent Firefox/Safari is fine.

## Install

```sh
bun install
```

## Build & verify

```sh
bun run build       # browser bundle + css + image/sound copy into dist/
bun run typecheck   # strict tsc --noEmit
bun test            # rng, storage migration, utility math, lockstep determinism
bun run test:e2e:webrtc      # headless Chrome host/join WebRTC smoke test
bun run test:e2e:webrtc:long # ~30s drift smoke; asserts zero state-hash mismatches
bun run dist        # clean -> typecheck -> test -> build, in that order
```

The full release gate (automated + manual LAN steps) lives in [`docs/release.md`](docs/release.md). For multiplayer releases also walk through [`docs/qa-lan-smoke.md`](docs/qa-lan-smoke.md) on two physical devices and record the run with [`docs/qa-lan-results-template.md`](docs/qa-lan-results-template.md).

For iterative frontend work:

```sh
bun run watch:js
bun run watch:css
```

## Play locally

One process, one port. The dev server is the LAN signaling server - same code path as production, hosting and joining work without extra setup:

```sh
bun run build       # first time only; regenerates the embedded asset manifest
bun run serve
# open http://localhost:8787
```

Single-player and split-keyboard work out of the box. Players activate by pressing their assigned keys on the menu screen; SPACE starts.

## LAN multiplayer

The same `bun run serve` process brokers signaling on the same host and port. Joiners on the LAN open `http://<host-lan-ip>:8787/`.

The client defaults to same-origin signaling, so when the page is loaded from this server you don't have to touch `OiSving.Config.Net.signalingUrl`. WebRTC's STUN handshake lifts the call off the server once datachannels are open - signaling is just rendezvous.

The room flow:

1. Host clicks **Host Game** on the menu, gets a 4-character code (no I/L/O/0/1, easier to read out loud).
2. Joiners click **Join Game** and type the code.
3. Host hits SPACE.

Gameplay is lockstep. Every peer simulates the whole game from the same seed; only per-frame input bitfields cross the wire. Bandwidth is trivial. The "feel" is preserved by applying the same `inputDelayFrames` (default 2 ≈ 33ms) to local AND remote input so own input never feels snappier than remote.

This part is honest-experimental. Single-player is solid. The two-browser smoke test that proves the lockstep handshake end-to-end hasn't been run yet, so expect rough edges until then.

## Standalone single-file executable

`bun run build:standalone` produces `dist/server/oi-sving-signaling` - a single binary with the browser bundle, CSS, sounds, images, and `index.html` all embedded inside. Copy it anywhere and run; nothing else required.

```sh
bun run build:standalone
./dist/server/oi-sving-signaling
# open http://localhost:8787
```

Override port or bind host as needed:

```sh
BIND_HOST=0.0.0.0 PORT=9000 ./dist/server/oi-sving-signaling
```

## Cloudflare Workers

If you'd rather run signaling on the edge, `server/signaling-worker.ts` + `server/signaling-room.ts` are a deployable Worker + Durable Object pair. See `server/README.md` for the `wrangler.toml` snippet and deploy steps. After deploy:

```js
OiSving.Config.Net.signalingUrl = 'wss://<your-worker>.workers.dev/ws'
```

## How determinism works

A few moving parts that earn their keep:

- **Mulberry32 seeded RNG** (`src/rng.ts`) replaces every `Math.random()` on the simulation path - five call sites: random initial angle, hole interval randomness, random spawn X/Y, and the RANDOM superpower picker. The host issues a seed in the START packet and every peer reseeds before tick 0.
- **Canonical arena** (`Field.setArenaSize`) decouples simulation from viewport. Collision, spawn, power-up, and state-hash math all run against arena coordinates; the local PIXI stage is scaled to fit. A 1280x720 host arena renders identically on a phone or a wide monitor.
- **Input provider seam** (`src/input-provider.ts`) so Curve and the superpower hooks read bits via `getInputProvider().get(frameId, playerId)` instead of polling `keysDown` directly. Single-player uses a keyboard provider that ignores `frameId`; network mode uses a buffer with `inputDelayFrames` of redundancy.
- **State-hash gossip**. Every 60 frames each peer FNV-1a's `(arenaW, arenaH, ...curves[(round(x*100), round(y*100), round(angle*1e6), holeCountDown, running)] in stable lexical order)` and broadcasts the result. Mismatch fires `state-hash-mismatch`. Drift is visible within a second.

The lockstep determinism test (`tests/lockstep-determinism.test.ts`) runs two synthetic peer worlds with the same seed and the same scripted input sequence and asserts they produce the same state-hash trail. Different seed or flipped inputs diverge.

## Project layout

- `src/` - browser game. `namespace.ts` owns the shared `OiSving` object; per-module files (`OiSving<X>.ts`) augment it. `main.ts` imports them in dependency order so each module finds the slots it needs already populated.
- `src/net.ts`, `src/rng.ts`, `src/input-provider.ts` - multiplayer plumbing.
- `scss/` - compiled to `dist/css/main.css`.
- `sound/` and `images/` - static runtime assets, copied into `dist/`.
- `server/` - LAN signaling (Bun) and Workers signaling (Cloudflare).
- `tests/` - Bun test suite. `bun test` runs everything.
- `scripts/` - build helpers (`build.ts`, `compile-signaling.ts`).

Most of the legacy modules still wear `// @ts-nocheck` while their types are tightened incrementally. The new code (`namespace.ts`, `main.ts`, `rng.ts`, `input-provider.ts`, `net.ts`, the storage and analytics modules, tests) is fully typed.

## What's not done yet

Honest list:

- The two-browser smoke test for the lockstep flow.
- A proper roster -> Menu wiring so remote players show up as filled slots in the player list.
- A stall budget for missing remote inputs. Right now the buffer's last-known-bits fallback covers single dropped packets cleanly; multi-packet stalls would benefit from a brief frame-skip budget instead of leaning on fallback.
- TURN config. STUN-only is fine on most home networks but symmetric NATs will need it.

## License

GPL-3.0. Forked from [Markus Mächler's Kurve](https://github.com/maechler/kurve). The simulation, audio, and superpower mechanics are his work. The rebrand, Bun + TypeScript port, deterministic core, and multiplayer transport are mine.
