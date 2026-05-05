# LAN Multiplayer Smoke Checklist

Manual pass/fail checklist for verifying multiplayer on real LAN before tagging a release. Pair with [`qa-lan-results-template.md`](./qa-lan-results-template.md) - copy it to `docs/qa-lan-results-YYYY-MM-DD.md` and fill it in as you go.

## Prerequisites

- Two physical devices on the same Wi-Fi or wired LAN.
- Both devices reach each other (no AP isolation, no client-isolation on the SSID).
- Host machine has Bun installed and a checkout of this repo.
- Joiner only needs a modern browser. No checkout required.

## Setup (host machine)

```sh
bun install        # first time only
bun run build
bun run serve
```

The server binds `0.0.0.0:8787` by default. The first log line prints the LAN URL it expects joiners to use, e.g. `http://192.168.1.42:8787/`.

If joiners cannot reach that URL:

- check the host firewall is allowing inbound TCP 8787 (macOS: System Settings -> Network -> Firewall; Windows: Defender Firewall inbound rule);
- confirm both devices are on the same SSID/VLAN;
- try `BIND_HOST=0.0.0.0 PORT=8787 bun run serve` explicitly.

## Checklist

For each item: tick the box, note observed behavior, capture console output if anything is off.

### Boot

- [ ] Host opens `http://localhost:8787/`. Menu screen renders. No console errors.
- [ ] Joiner opens `http://<host-lan-ip>:8787/`. Menu screen renders. No console errors.
- [ ] Both browsers show `OiSving.Net` is defined (`window.OiSving.Net` in DevTools console).

Expected: both peers load the same bundle from the same host. If joiner's page is blank, suspect firewall or wrong LAN IP.

### Host room

- [ ] Host activates one player (press the player's "left" key, e.g. `1` for red).
- [ ] Host clicks **Host Game**. A 4-character room code appears.
- [ ] Host's `net-status` indicator shows the host is hosting and waiting.

Expected: room code uses an unambiguous alphabet (no I/L/O/0/1).

### Joiner connects

- [ ] Joiner activates a different player (different keys, different color).
- [ ] Joiner clicks **Join Game** and enters the host's code.
- [ ] Within ~3 seconds, both peers' menus show the other side's player ID.

Expected: roster is bidirectional. Host sees joiner's player; joiner sees host's player. If only one direction populates, the WebRTC handshake completed only one way - capture both consoles and the server log.

### Round 1

- [ ] Host presses SPACE. Game screen appears on both devices.
- [ ] Both devices show two curves with correct local/remote ownership (the local curve is the one you can control with your local keys).
- [ ] Host presses SPACE again to start the round. Both curves start moving.
- [ ] Host steers only its own curve. Joiner steers only its own curve. Neither side can move the other's curve.
- [ ] Round ends naturally (one curve survives or both die). Round-end overlay appears on both devices.
- [ ] No console errors on either browser during the round.

Expected: state-hash-mismatch events do not fire. Open DevTools and watch for `[state-hash mismatch]` warnings - any occurrence is a fail.

### Round 2

- [ ] From the round-end overlay, start a second round (SPACE on host).
- [ ] Both devices enter round 2. Both curves render. Steering still maps correctly.
- [ ] No reload required between rounds.

### Disconnect behavior

- [ ] Joiner closes the tab mid-round. Host's UI reflects the joiner left (no hang, no infinite "waiting for input" stall).
- [ ] Host can host a new room without restarting the server.

Optional, if you have time:

- [ ] Host refreshes the page. Joiner observes the connection drop cleanly. Joiner can reconnect after host hosts again.

## Pass criteria

The smoke passes if every box in **Boot**, **Host room**, **Joiner connects**, **Round 1**, and **Round 2** is ticked with no console errors and no state-hash mismatches. **Disconnect behavior** is best-effort - file an issue rather than block release if it misbehaves.

## On failure

1. Capture both browsers' DevTools console output (export as JSON or copy the text).
2. Capture the server's stdout/stderr from the host terminal.
3. Record host LAN IP, both browser versions, both OS versions.
4. Save the artifacts in `docs/qa-lan-results-YYYY-MM-DD.md` (or a referenced gist) and open an issue before changing implementation.
