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

1. **Host** clicks **Host Game**. A 4-character room code appears (no I/L/O/0/1, easier to read out loud) along with a list of any other rooms running on the same LAN.
2. **Joiners** click **Join Game** and type the code, or click a room from the available-games list.
3. After joining, **pick a color**. The menu locks colors that the host or other joiners have already taken; a "waiting for host" banner stays visible above the player list while the room is forming.
4. **Host** clicks **Start Game** (or hits SPACE). The button only enables when the combined roster has ≥2 players.

Host is the source of truth for the round - seed, arena, fps, hole timing, allowed colors, start, pause, unpause, and the final roster all come from the host. Joiners run the same lockstep simulation locally, so only per-frame input bits cross the wire. Bandwidth is trivial.

#### Edge cases worth knowing

- The host can run in **host-only mode** (zero local players) and just referee the room.
- The browser shows a "leaving will drop you" prompt if you try to refresh or close the tab during a live multiplayer session.
- Joiners cannot accidentally start a phantom local game by pressing SPACE - the menu and pause keys are gated to host-only.
- Symmetric NATs may need a TURN server (not shipped). Same-LAN play is the primary target.

## Building from source / contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for the Bun toolchain, build commands, determinism architecture, project layout, and the things that aren't done yet.

## License

GPL-3.0. Forked from [Markus Mächler's Kurve](https://github.com/maechler/kurve). The simulation, audio, and superpower mechanics are his work. The rebrand, Bun + TypeScript port, deterministic core, and multiplayer transport are mine.
