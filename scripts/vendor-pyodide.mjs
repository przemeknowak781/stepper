/**
 * Copy Pyodide's distribution out of node_modules into `public/pyodide/`.
 *
 * Needed because the npm package resolves its default `indexURL` relative to
 * its own module location at runtime, and Vite relocates that module into the
 * worker chunk — so the derived URL points at files that were never emitted.
 * Serving the distribution from our own origin under a path we control is what
 * makes it resolvable in both dev and a built deploy.
 *
 * The wheels come too, and that is not optional: `pyodide-lock.json` records
 * them as bare filenames resolved against the same `indexURL`, so hosting the
 * core alone just trades a missing `.wasm` for `No module named 'micropip'`.
 *
 * Generated, not committed — `public/pyodide/` is gitignored and this runs as
 * part of `pnpm build`.
 */

import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const source = dirname(require.resolve('pyodide/package.json'))
const target = join(process.cwd(), 'public', 'pyodide')

/** Pyodide packages the worker actually imports. Everything else stays out. */
const PACKAGES = ['numpy', 'micropip']

const CORE = [
  'pyodide.asm.js',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'pyodide.mjs',
  'python_stdlib.zip',
  'pyodide-lock.json',
]

mkdirSync(target, { recursive: true })

let copied = 0
for (const name of CORE) {
  const from = join(source, name)
  // The exact core file list shifts between Pyodide releases (`pyodide.asm.js`
  // is gone in recent ones). Copy what exists rather than pinning a list that
  // breaks on upgrade; a genuinely missing file surfaces as a 404 in the
  // worker, not as a silent half-copy, because the lock file below is checked.
  if (!existsSync(from)) continue
  copyFileSync(from, join(target, name))
  copied++
}

const lock = JSON.parse(readFileSync(join(source, 'pyodide-lock.json'), 'utf8'))
const queue = [...PACKAGES]
const seen = new Set()
while (queue.length) {
  const name = queue.pop()
  if (seen.has(name)) continue
  seen.add(name)
  const entry = lock.packages[name]
  if (!entry) throw new Error(`vendor-pyodide: ${name} is not in pyodide-lock.json`)
  const from = join(source, entry.file_name)
  if (!existsSync(from)) {
    // Pyodide ships its wheels in the npm package; if one is absent the runtime
    // would fetch it from the CDN instead, quietly reintroducing the network
    // dependency this script exists to remove. Fail loudly.
    throw new Error(`vendor-pyodide: ${entry.file_name} missing from the pyodide package`)
  }
  copyFileSync(from, join(target, entry.file_name))
  copied++
  queue.push(...(entry.depends ?? []))
}

console.log(`vendor-pyodide: ${copied} files -> public/pyodide (${[...seen].sort().join(', ')})`)
