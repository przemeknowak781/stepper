import type { RepairOptions, RepairResponse } from './client'
import type {
  MeshfixWorkerInMessage,
  MeshfixWorkerOutMessage,
} from '@/workers/meshfix.worker'

/**
 * meshfix in the browser, same API shape as the local-service client.
 *
 * Two ways to reach the same tool: `client.ts` talks to `meshfix serve` over
 * loopback, this runs it in a worker on Pyodide. Callers pick, but they read
 * the same `RepairResponse` either way, because both funnel into the *same*
 * Python entry point (`meshfix.serve._process`).
 *
 * The runtime is ~16 MB and takes a few seconds to boot, so nothing is loaded
 * until `start()` — the worker module itself is behind a dynamic import, which
 * keeps Pyodide out of the main bundle entirely for anyone who never asks.
 */

export type RuntimeStatus = 'idle' | 'loading-runtime' | 'ready' | 'working' | 'failed'

export interface BrowserMeshfix {
  run(mode: 'repair' | 'diagnose', stl: ArrayBuffer, options?: RepairOptions): Promise<RepairResponse>
  /** Boot now so the first real call does not pay for it. Safe to call twice. */
  prewarm(): void
  dispose(): void
}

/**
 * Whether this browser can host the runtime at all. Pyodide needs
 * WebAssembly and a module worker; anything older than that gets told so
 * rather than being left staring at a spinner.
 */
export function isSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'
}

export function createBrowserMeshfix(
  onStatus: (status: RuntimeStatus) => void,
): BrowserMeshfix {
  let worker: Worker | null = null
  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (value: RepairResponse) => void; reject: (error: Error) => void }
  >()

  const ensureWorker = (): Worker => {
    if (worker) return worker
    // `new URL(..., import.meta.url)` is the form Vite recognises to emit the
    // worker as its own chunk; a bare string would be left as a runtime path
    // that does not survive the build.
    worker = new Worker(new URL('../../workers/meshfix.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (ev: MessageEvent<MeshfixWorkerOutMessage>) => {
      const message = ev.data
      if (message.type === 'status') {
        onStatus(message.status)
        return
      }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.type === 'result') {
        onStatus('ready')
        entry.resolve(message.result)
      } else {
        onStatus('failed')
        entry.reject(new Error(message.message))
      }
    }
    worker.onerror = (event) => {
      // A worker-level error kills every in-flight call; failing them
      // individually beats leaving the promises hanging forever.
      onStatus('failed')
      const error = new Error(event.message || 'the meshfix worker failed to start')
      for (const [, entry] of pending) entry.reject(error)
      pending.clear()
    }
    return worker
  }

  const post = (message: MeshfixWorkerInMessage, transfer: Transferable[] = []) => {
    ensureWorker().postMessage(message, transfer)
  }

  return {
    run(mode, stl, options = {}) {
      const id = nextId++
      return new Promise<RepairResponse>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        // The buffer is transferred, not copied — a big STL would otherwise be
        // duplicated on the way in. The caller's view is detached afterwards,
        // which is why this takes a buffer the caller is done with.
        post({ type: 'run', id, mode, stl, options }, [stl])
      })
    },
    prewarm() {
      post({ type: 'prewarm' })
    },
    dispose() {
      worker?.terminate()
      worker = null
      pending.clear()
      onStatus('idle')
    },
  }
}
