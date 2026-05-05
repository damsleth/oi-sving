# Release Gate

Two layers: an automated gate that every commit on `main` must pass, and a manual gate that runs once before tagging a multiplayer release.

## Automated gate (required)

Run from a clean checkout. All four must pass:

```sh
bun run typecheck
bun test
bun run build:standalone
bun run test:e2e:webrtc
```

What each one buys:

- `bun run typecheck` - strict `tsc --noEmit`. Catches type drift across the namespace surface.
- `bun test` - RNG, storage migration, utility math, lockstep determinism on synthetic peers.
- `bun run build:standalone` - browser bundle plus the embedded-asset single-file Bun executable. Verifies the asset manifest stays in sync with `dist/`.
- `bun run test:e2e:webrtc` - headless Chrome host/join smoke. Two real browser tabs, real WebRTC datachannels, real signaling server. Verifies both peers reach `isRunning` with two curves, correct local/remote ownership, and `CURRENT_FRAME_ID > 0`.

Optional but recommended before tag:

- `bun run test:e2e:webrtc:long` - same harness as the smoke, but drives both peers with scripted input for ~30s and asserts zero `state-hash-mismatch` events. Catches drift regressions that a single-frame smoke would miss. Override duration with `DRIFT_SECONDS=60`.

## Manual gate (multiplayer releases only)

Single-player releases ship on the automated gate alone. Multiplayer releases need real-LAN evidence:

1. **Two-device Chrome/Chrome LAN smoke.** Walk through [`docs/qa-lan-smoke.md`](./qa-lan-smoke.md) on two physical devices on the same Wi-Fi or wired LAN. Capture results in `docs/qa-lan-results-YYYY-MM-DD.md` from [`qa-lan-results-template.md`](./qa-lan-results-template.md). Commit alongside the release.
2. **Standalone executable smoke outside the repo.** Confirm `dist/server/oi-sving-signaling` runs with no repo files present:

   ```sh
   bun run build:standalone
   mkdir -p /tmp/oi-sving-standalone-smoke
   cp dist/server/oi-sving-signaling /tmp/oi-sving-standalone-smoke/
   cd /tmp/oi-sving-standalone-smoke
   ./oi-sving-signaling
   ```

   Hit `http://localhost:8787/health`, then run a host/join browser pair against the standalone binary.
3. **At least one cross-browser pair.** Minimum: Chrome host + Firefox joiner, or Chrome host + Safari joiner. Document version, OS, and any console output that differs from the Chrome/Chrome run.

Pre-tag checklist:

- [ ] `docs/qa-lan-results-YYYY-MM-DD.md` committed with PASS results for the Chrome/Chrome run.
- [ ] Standalone binary smoke recorded as PASS (separate result file or notes appended to the LAN run).
- [ ] At least one non-Chrome joiner recorded as PASS, or the failure is tracked as a known limitation in release notes.
- [ ] Any state-hash mismatches observed in any run are either fixed before tag or filed as blockers, not waved through.

## What this gate does not cover

Documented as residual risk, not blockers:

- Hostile or symmetric NAT without TURN.
- WAN play.
- High packet loss.
- Mobile Safari backgrounding behavior.
- More than two peers (three+ peers exercise different mesh paths than the QA gate validates).

These are product-scope expansions, not release blockers for the local/LAN multiplayer MVP.
