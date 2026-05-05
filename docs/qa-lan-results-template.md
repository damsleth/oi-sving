# LAN QA Run - YYYY-MM-DD

Copy this file to `docs/qa-lan-results-YYYY-MM-DD.md` for each real-LAN run and commit alongside the release. Pair with [`qa-lan-smoke.md`](./qa-lan-smoke.md).

## Run metadata

| Field | Value |
|-------|-------|
| Date / time |  |
| Tester |  |
| Commit SHA |  |
| Build command | `bun run build` / `bun run build:standalone` |
| Server command | `bun run serve` / standalone binary |
| Network type | Wi-Fi 5GHz / Wi-Fi 2.4GHz / Ethernet / mixed |
| Host LAN URL |  |

## Devices

| Role | OS | Browser | Browser version |
|------|----|---------|-----------------|
| Host |  |  |  |
| Joiner |  |  |  |

## Smoke checklist results

| Section | Result | Notes |
|---------|--------|-------|
| Boot | PASS / FAIL |  |
| Host room | PASS / FAIL |  |
| Joiner connects | PASS / FAIL |  |
| Round 1 | PASS / FAIL |  |
| Round 2 | PASS / FAIL |  |
| Disconnect behavior | PASS / FAIL / SKIP |  |

## Observed feel

- Latency / responsiveness:
- Steering / hit registration:
- Round-start sync:

## Console errors

Paste host browser console (filtered for warnings + errors):

```
```

Paste joiner browser console:

```
```

## Drift / state-hash mismatch events

Search both consoles for `state-hash mismatch`. Record any frame IDs and counts:

| Peer | Frame ID | Expected | Actual |
|------|----------|----------|--------|
|      |          |          |        |

If the count is non-zero, attach a longer transcript and open an issue. State-hash mismatches indicate determinism drift and are blockers.

## Server output

Paste relevant lines from the host terminal:

```
```

## Follow-ups

- [ ] Issues opened (link):
- [ ] Known limitations to note in release notes:
- [ ] Re-run required: yes / no
