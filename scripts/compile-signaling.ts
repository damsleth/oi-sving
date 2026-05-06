import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const outDir = join(root, 'dist/server')
const outFile = join(outDir, process.platform === 'win32' ? 'oi-sving.exe' : 'oi-sving')
const entrypoint = join(root, 'server/signaling-server.ts')

await mkdir(outDir, { recursive: true })

const proc = Bun.spawn({
  cmd: ['bun', 'build', entrypoint, '--compile', '--minify', '--target=bun', '--outfile', outFile],
  stdout: 'inherit',
  stderr: 'inherit',
})

const exitCode = await proc.exited
if (exitCode !== 0) process.exit(exitCode)

console.log(`signaling executable written to ${outFile}`)
