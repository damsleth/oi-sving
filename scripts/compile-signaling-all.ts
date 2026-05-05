// Cross-compile the standalone signaling executable for every platform we
// publish as a release asset. Used by the GitHub Actions release workflow;
// safe to run locally too. Local dev should still prefer
// `bun run build:standalone`, which only builds for the current platform.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

interface Target {
  bunTarget: string
  archiveSuffix: string
  binaryName: string
}

const targets: Target[] = [
  { bunTarget: 'bun-linux-x64',          archiveSuffix: 'linux-x64',          binaryName: 'oi-sving-signaling' },
  { bunTarget: 'bun-linux-x64-baseline', archiveSuffix: 'linux-x64-baseline', binaryName: 'oi-sving-signaling' },
  { bunTarget: 'bun-linux-arm64',        archiveSuffix: 'linux-arm64',        binaryName: 'oi-sving-signaling' },
  { bunTarget: 'bun-darwin-x64',         archiveSuffix: 'darwin-x64',         binaryName: 'oi-sving-signaling' },
  { bunTarget: 'bun-darwin-arm64',       archiveSuffix: 'darwin-arm64',       binaryName: 'oi-sving-signaling' },
  { bunTarget: 'bun-windows-x64',        archiveSuffix: 'windows-x64',        binaryName: 'oi-sving-signaling.exe' },
]

const root = new URL('..', import.meta.url).pathname
const baseOut = join(root, 'dist/server/release')
const entrypoint = join(root, 'server/signaling-server.ts')

await mkdir(baseOut, { recursive: true })

let failed = 0
for (const t of targets) {
  const outDir = join(baseOut, t.archiveSuffix)
  await mkdir(outDir, { recursive: true })
  const outFile = join(outDir, t.binaryName)

  const proc = Bun.spawn({
    cmd: ['bun', 'build', entrypoint, '--compile', '--minify', `--target=${t.bunTarget}`, '--outfile', outFile],
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error(`compile failed for ${t.bunTarget} (exit ${exitCode})`)
    failed++
    continue
  }
  console.log(`built ${t.bunTarget} -> ${outFile}`)
}

if (failed > 0) {
  console.error(`${failed} target(s) failed`)
  process.exit(1)
}
