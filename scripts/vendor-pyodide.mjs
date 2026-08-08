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
 * The npm package does **not** ship those wheels — its `files` field lists the
 * core only — so they are downloaded from the release CDN, pinned to the
 * installed version, and cached in the output directory. Do not be fooled by
 * finding them in `node_modules` locally: Pyodide writes wheels it has fetched
 * back there ("caching the wheel in node_modules for future use"), so a machine
 * that has ever run it looks like the package ships them, and CI does not.
 *
 * Generated, not committed — `public/pyodide/` is gitignored and this runs as
 * part of `pnpm build`.
 */

import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const source = dirname(require.resolve('pyodide/package.json'))
const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const target = join(process.cwd(), 'public', 'pyodide')

/** Where Pyodide publishes the wheels its lock file names, for this exact version. */
const CDN = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`

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
  const to = join(target, entry.file_name)
  const from = join(source, entry.file_name)
  if (existsSync(from)) {
    copyFileSync(from, to)
  } else if (!existsSync(to)) {
    // Not in the package and not already vendored, so fetch it once. Skipping
    // this would leave the runtime to reach for the CDN itself at page load,
    // quietly reintroducing the network dependency this script exists to
    // remove — the failure the caller would see is `No module named
    // 'micropip'`, which says nothing about a missing wheel.
    const response = await fetch(CDN + entry.file_name)
    if (!response.ok) {
      throw new Error(
        `vendor-pyodide: cannot fetch ${entry.file_name} (${response.status}) from ${CDN}`,
      )
    }
    writeFileSync(to, Buffer.from(await response.arrayBuffer()))
  }
  copied++
  queue.push(...(entry.depends ?? []))
}

// The worker cannot boot without these, and a missing one shows up at runtime
// as a 404 inside a wasm loader rather than as a build failure. Check here,
// where the message can say what is actually wrong.
const REQUIRED = ['pyodide.asm.wasm', 'pyodide.asm.mjs', 'python_stdlib.zip', 'pyodide-lock.json']
for (const name of REQUIRED) {
  const path = join(target, name)
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`vendor-pyodide: ${name} is missing or empty in ${target}`)
  }
}

console.log(`vendor-pyodide: ${copied} files -> public/pyodide (${[...seen].sort().join(', ')})`)
