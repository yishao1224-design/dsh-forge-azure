/**
 * Build `lib/index.js`, the Host module the Loader imports for the row in `cordis.patch.yml`.
 *
 * The module runs from the installed folder without a `node_modules`, so everything except Node built-ins is inlined
 * (the `diff` package), and nothing is imported from DSH packages at run time: their types are erased.
 */
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

await build({
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node24',
  noExternal: [/.*/],
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
})
