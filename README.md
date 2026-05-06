# Oi, Sving!

> _tl;dr - HTML5 multiplayer Achtung. Download a single binary, run it, point your friends at the URL. Up to six players on one LAN, no relay, no signup, no nothing._

The name is a loose Norwegian-ish riff on the German _Achtung, die Kurve!_ . Forked from [maechler/kurve](https://github.com/maechler/kurve), rebranded, ported to Bun + TypeScript, and rebuilt around a deterministic lockstep core.

## Quickstart

1. Grab the binary for your OS from the [Releases page](https://github.com/damsleth/oi-sving/releases).
2. Extract.
3. Run it.
4. Open `http://localhost:8787`.

That's it. The binary serves the game and brokers LAN signaling on the same port - one process, no extra setup.

| Platform | Asset suffix |
|----------|--------------|
| Linux x64 (modern CPU) | `linux-x64.tar.gz` |
| Linux x64 (older CPU, no AVX2) | `linux-x64-baseline.tar.gz` |
| Linux arm64 | `linux-arm64.tar.gz` |
| macOS Intel | `darwin-x64.tar.gz` |
| macOS Apple Silicon | `darwin-arm64.tar.gz` |
| Windows x64 | `windows-x64.zip` |

Each release ships a `SHA256SUMS.txt`. Verify with `shasum -a 256 -c SHA256SUMS.txt` before running if you care.

Override port or bind host as needed:

```sh
BIND_HOST=0.0.0.0 PORT=9000 ./oi-sving-signaling
```

## Playing

Single-player and split-keyboard work out of the box. Players activate by pressing their assigned keys on the menu screen. SPACE starts.

### LAN multiplayer

Joiners on the same network open `http://<host-lan-ip>:8787/` in any modern browser. Then:

1. Host clicks **Host Game**, gets a 4-character code (no I/L/O/0/1, easier to read out loud).
2. Joiners click **Join Game** and type the code.
3. Host hits SPACE.

Gameplay is lockstep - every peer simulates the whole game from the same seed and only per-frame input bits cross the wire. Bandwidth is trivial. Works on most home networks; symmetric NATs may need a TURN server (not shipped).

This part is honest-experimental. Single-player is solid. Multiplayer is wired end-to-end but the two-browser smoke test that proves the lockstep handshake hasn't been run yet, so expect rough edges.

## Building from source / contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for the Bun toolchain, build commands, determinism architecture, project layout, and the things that aren't done yet.

## License

GPL-3.0. Forked from [Markus Mächler's Kurve](https://github.com/maechler/kurve). The simulation, audio, and superpower mechanics are his work. The rebrand, Bun + TypeScript port, deterministic core, and multiplayer transport are mine.
