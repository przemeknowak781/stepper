import { loadPyodide, type PyodideInterface } from 'pyodide'
import type { MeshfixReport, RepairOptions, RepairResponse } from '@/lib/meshfix/client'

/**
 * meshfix running in the browser, on CPython compiled to wasm.
 *
 * The same repair tool as `tools/meshfix`, without asking the user to install
 * Python — and, more to the point, running the *same source*: the `.py` files
 * are bundled from `tools/meshfix/meshfix/` and written into Pyodide's
 * filesystem, so there is one implementation of the criteria, not a
 * re-derivation in TypeScript that drifts.
 *
 * It is opt-in and lazy. Booting costs ~5 s and a few MB, which nobody should
 * pay for a model that converts perfectly well without it.
 *
 * What is *not* available here: the `alphawrap` backend, which is a native
 * CGAL binary. In the browser the chain is `voxel` alone, and the report says
 * so in its warnings rather than pretending otherwise.
 */

// Every .py under the package, bundled as source at build time. Vite resolves
// this at build, so the files ship inside the worker chunk — no second copy of
// meshfix to keep in sync, and no network fetch at runtime.
const PACKAGE_SOURCES = import.meta.glob('../../tools/meshfix/meshfix/**/*.py', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * Pyodide's core (`pyodide.asm.mjs/.wasm`, the stdlib zip, the lock file) and
 * the numpy/micropip wheels it lists are self-hosted under `public/pyodide/`.
 *
 * Not a preference — the npm package resolves its default `indexURL` relative
 * to its own module location at runtime, and Vite relocates that module into
 * the worker chunk, so the derived URL points at files that were never
 * emitted. The wheels have to move too: `pyodide-lock.json` records them as
 * bare filenames resolved against the same `indexURL`, so hosting the core
 * without them just trades one 404 for `No module named 'micropip'`. Both
 * failures were hit for real in the sibling Optimizer repo; this mirrors the
 * fix rather than rediscovering it.
 */
const PYODIDE_CORE_DIR = 'pyodide/'

/**
 * trimesh is not part of Pyodide's distribution, so its wheel is self-hosted
 * too. Pinned to the version the test suite runs against — meshfix reads
 * enough of trimesh's surface (`is_winding_consistent`, `edges_sorted`,
 * `sample.sample_surface`) that a silent major-version bump is a real risk.
 * micropip parses the *filename* for name and version, so it must keep the
 * canonical wheel name.
 */
const TRIMESH_WHEEL = 'wheels/trimesh-4.12.2-py3-none-any.whl'

export type MeshfixWorkerInMessage =
  | { type: 'prewarm' }
  | {
      type: 'run'
      id: number
      mode: 'repair' | 'diagnose'
      stl: ArrayBuffer
      options: RepairOptions
    }

export type MeshfixWorkerOutMessage =
  | { type: 'status'; status: 'loading-runtime' | 'ready' | 'working' }
  | { type: 'result'; id: number; result: RepairResponse }
  | { type: 'error'; id: number; message: string }

/**
 * The main-thread tsconfig uses the `DOM` lib; adding `WebWorker` globally
 * would conflict over shared globals. Casting a minimal local shape avoids a
 * second tsconfig for one file.
 */
const ctx = globalThis as unknown as {
  postMessage: (message: MeshfixWorkerOutMessage) => void
  onmessage: ((ev: MessageEvent<MeshfixWorkerInMessage>) => void) | null
  location: { href: string }
}

let runtime: Promise<PyodideInterface> | null = null

function assetUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}${path}`, ctx.location.href).href
}

/** Write the bundled package sources into the wasm filesystem under /pkg. */
function installPackage(pyodide: PyodideInterface): void {
  const prefix = '../../tools/meshfix/'
  pyodide.FS.mkdirTree('/pkg')
  for (const [key, source] of Object.entries(PACKAGE_SOURCES)) {
    const relative = key.slice(key.indexOf(prefix) + prefix.length)
    const directory = relative.slice(0, relative.lastIndexOf('/'))
    pyodide.FS.mkdirTree(`/pkg/${directory}`)
    pyodide.FS.writeFile(`/pkg/${relative}`, source)
  }
}

async function ensureRuntime(): Promise<PyodideInterface> {
  if (!runtime) {
    ctx.postMessage({ type: 'status', status: 'loading-runtime' })
    runtime = (async () => {
      const pyodide = await loadPyodide({ indexURL: assetUrl(PYODIDE_CORE_DIR) })
      await pyodide.loadPackage(['numpy', 'micropip'])

      const wheel = await fetch(assetUrl(TRIMESH_WHEEL))
      if (!wheel.ok) throw new Error(`cannot fetch the trimesh wheel (${wheel.status})`)
      const name = TRIMESH_WHEEL.slice(TRIMESH_WHEEL.lastIndexOf('/') + 1)
      pyodide.FS.writeFile(`/${name}`, new Uint8Array(await wheel.arrayBuffer()))
      // `emfs:` installs from the wasm filesystem instead of resolving the name
      // through PyPI's API, so no request leaves the page.
      await pyodide.runPythonAsync(
        `import micropip\nawait micropip.install("emfs:/${name}")\n`,
      )

      installPackage(pyodide)
      await pyodide.runPythonAsync(`
import sys
if "/pkg" not in sys.path:
    sys.path.insert(0, "/pkg")
from meshfix.serve import _process
`)
      ctx.postMessage({ type: 'status', status: 'ready' })
      return pyodide
    })()
    runtime = runtime.catch((error) => {
      runtime = null // a failed boot must not poison every later attempt
      throw error
    })
  }
  return runtime
}

/** The query parameters `_process` reads, matching the HTTP service exactly. */
function toParams(options: RepairOptions): Record<string, string> {
  const params: Record<string, string> = {}
  if (options.voxelResolution !== undefined) params.voxel_resolution = String(options.voxelResolution)
  if (options.seal !== undefined) params.seal = String(options.seal)
  if (options.shellThickness !== undefined) params.shell_thickness = String(options.shellThickness)
  if (options.expectedComponents !== undefined) params.expected_components = String(options.expectedComponents)
  if (options.maxDeviation !== undefined) params.max_deviation = String(options.maxDeviation)
  if (options.seed !== undefined) params.seed = String(options.seed)
  return params
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

ctx.onmessage = async (ev) => {
  const message = ev.data
  if (message.type === 'prewarm') {
    void ensureRuntime().catch(() => {
      // A failed prewarm is not an error anyone asked about; the next real run
      // reports it properly.
    })
    return
  }
  if (message.type !== 'run') return

  try {
    const pyodide = await ensureRuntime()
    ctx.postMessage({ type: 'status', status: 'working' })

    pyodide.FS.writeFile('/input.stl', new Uint8Array(message.stl))
    pyodide.globals.set('PARAMS_JSON', JSON.stringify(toParams(message.options)))
    pyodide.globals.set('DIAGNOSE_ONLY', message.mode === 'diagnose')
    const json: string = await pyodide.runPythonAsync(`
import json, pathlib
json.dumps(_process(
    pathlib.Path("/input.stl").read_bytes(),
    json.loads(PARAMS_JSON),
    diagnose_only=DIAGNOSE_ONLY,
))
`)
    const body = JSON.parse(json) as {
      report: MeshfixReport
      stl_base64: string | null
      refused?: string
    }
    ctx.postMessage({
      type: 'result',
      id: message.id,
      result: {
        report: body.report,
        stl: body.stl_base64 ? decodeBase64(body.stl_base64) : null,
        refused: body.refused,
      },
    })
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
