// Build the browser bundle. We use the Bun.build() programmatic API rather
// than the CLI because the CLI's --outfile silently strips path components,
// landing the bundle next to the entry instead of in dist/js/.

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const outDir = join(root, 'dist/js')
const isDev = process.env.NODE_ENV === 'development'
const minify = !isDev

await mkdir(outDir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(root, 'src/main.ts')],
  outdir: outDir,
  target: 'browser',
  minify,
  sourcemap: 'linked',
  define: {
    __DEV__: JSON.stringify(isDev),
  },
  naming: {
    entry: 'oisving.min.js',
    chunk: '[name].[hash].js',
    asset: '[name]-[hash].[ext]',
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Bun emits oisving.min.js.map, but if any prior partial run left a stale
// file with a non-deterministic chunk hash we drop it here.
const stale = await Array.fromAsync(new Bun.Glob('chunk-*.js').scan({ cwd: outDir }))
for (const f of stale) {
  await rm(join(outDir, f), { force: true })
}

console.log(`bundle written to ${outDir}/oisving.min.js`)
