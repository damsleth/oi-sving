# Development

> _tl;dr - Bun for everything. `bun install`, `bun run dist`, done. The interesting bits are the determinism harness and the same-port signaling server._

## Requirements

- [Bun](https://bun.sh/) for everything - install, dev, build, tests, signaling executable.
- A modern browser with WebRTC datachannels for testing multiplayer.

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

## Run the dev server

One process, one port. The dev server is the LAN signaling server - same code path as production, hosting and joining work without extra setup:

```sh
bun run build       # first time only; regenerates the embedded asset manifest
bun run serve
# open http://localhost:8787
```

The client defaults to same-origin signaling, so when the page is loaded from this server you don't have to touch `OiSving.Config.Net.signalingUrl`. WebRTC's STUN handshake lifts the call off the server once datachannels are open - signaling is just rendezvous.

## Build the standalone binary

`bun run build:standalone` produces `dist/server/oi-sving-signaling` - a single binary with the browser bundle, CSS, sounds, images, and `index.html` all embedded inside. Copy it anywhere and run; nothing else required.

```sh
bun run build:standalone
./dist/server/oi-sving-signaling
```

## Cutting a release

Maintainers cut a release by tagging `vX.Y.Z` and pushing the tag. GitHub Actions cross-compiles every target via `bun run build:release` and uploads the archives to the [Releases page](https://github.com/damsleth/oi-sving/releases). Local cross-compile is the same command:

```sh
bun run build:release   # writes dist/server/release/<target>/oi-sving-signaling
```

## Cloudflare Workers signaling

If you'd rather run signaling on the edge than on a laptop, `server/signaling-worker.ts` + `server/signaling-room.ts` are a deployable Worker + Durable Object pair. See `server/README.md` for the `wrangler.toml` snippet and deploy steps. After deploy:

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

The "feel" is preserved by applying the same `inputDelayFrames` (default 2 ≈ 33ms) to local AND remote input so own input never feels snappier than remote.

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
