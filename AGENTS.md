# Agent guidance for this repo

Notes for AI agents (Claude Code, Codex, etc.) working on `oi-sving`. Conventions and hard rules. The user's global `~/.claude/CLAUDE.md` still applies — this file only adds repo-specific rules.

## Release policy

**Every version cut must produce a published GitHub Release with downloadable assets.**

A "version cut" means any commit that changes `package.json` `version`. The act of bumping the version isn't done — the release is.

Required after a version bump:

1. Tag the commit: `git tag vX.Y.Z`.
2. Push the tag: `git push origin vX.Y.Z`.
3. Confirm `.github/workflows/release.yml` ran to completion (status `success`) on that tag.
4. Confirm the release exists on https://github.com/damsleth/oi-sving/releases with all six platform archives attached:
   - `linux-x64.tar.gz`, `linux-x64-baseline.tar.gz`, `linux-arm64.tar.gz`
   - `darwin-x64.tar.gz`, `darwin-arm64.tar.gz`
   - `windows-x64.zip`
   - `SHA256SUMS.txt`

If the workflow fails, fix it and either re-tag (force-update) or cut a patch version. Don't leave a tagged version with no release.

`gh run watch <run-id>` and `gh release view vX.Y.Z` are the verification commands.

## Build / verify before commit

The standard gate before any non-trivial commit:

```sh
bun run dist  # clean + typecheck + build + test, in that order
```

`bun run dist` is the canonical local equivalent of CI. The order matters:
build runs before test because the signaling-server integration test
spawns a child that imports `server/embedded-assets.ts`, which depends on
`dist/`. Running `bun test` directly skips the `pretest` hook - use
`bun run test` if you want the hook to fire and rebuild `dist/` first.

For changes that touch the multiplayer surface (`src/net.ts`, `src/input-buffer.ts`, `src/OiSvingGame.ts`, `src/OiSvingMenu.ts`, `server/signaling-server.ts`):

```sh
bun run test:e2e:webrtc       # ~5s headless smoke
bun run test:e2e:webrtc:long  # ~15s drift verification, asserts zero state-hash mismatches
```

For changes that touch the standalone binary surface (`scripts/compile-signaling*.ts`, `server/embedded-assets.ts`, `.github/workflows/release.yml`):

```sh
bun run test:smoke:standalone  # boots dist/server/oi-sving in a sandbox tmpdir
```

## Code conventions

- TypeScript / JavaScript: no semicolons.
- 2-space indentation, no tabs.
- Prettier-style spacing.
- Match the language the user initiates the conversation in.
- No emdash (`—`) in commits / docs / code; use a regular dash.
- Don't introduce comments that explain WHAT obvious code does. Comments should explain WHY a non-obvious choice was made.
- The legacy modules (most `OiSving*.ts` files) still wear `// @ts-nocheck`. New code should be fully typed; tighten existing modules incrementally if you touch them.

## Commit hygiene

- One commit per logical fix. Don't bundle unrelated changes.
- Commit subject in imperative mood, ≤ 72 chars. Body explains WHY.
- Reference the user-visible bug / behavior the commit fixes when relevant.

## Multiplayer determinism

`docs/protocol.md` is the canonical wire-protocol reference. Update it when the protocol changes. The lockstep contract relies on:

- Sorted curve iteration in `Game.drawFrame` and `Game.initRun`.
- `resetHoleCountDown` happening in `initRun` (post-seed), not in the `Curve` constructor.
- Sender-side input redundancy + frame-ordered fallback in `InputBuffer`.
- Frame-aligned hash compare in `MSG_STATE_HASH` dispatch.

Touching any of those without re-running `bun run test:e2e:webrtc:long` is a regression waiting to happen.

## .planning / .plans

`.plans/todo.md` is the running scratch list. Plans get folded back in when items close; the file itself is gitignored — local-only working memory.
