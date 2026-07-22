import { useCallback } from 'react'
import { parseSTL } from '@/lib/stl/parseSTL'
import { useConverterStore } from '@/state/converterStore'

/** Load the bundled reference part (public/examples/m2.stl) into the store. */
export function useLoadSample() {
  return useCallback(async () => {
    const store = useConverterStore.getState()
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}examples/m2.stl`)
      if (!res.ok) throw new Error(`Failed to fetch sample (${res.status})`)
      const buf = await res.arrayBuffer()
      const parsed = parseSTL(buf)
      store.setInput(
        { vertices: parsed.vertices, indices: null, triangleCount: parsed.triangleCount },
        'm2.stl',
      )
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Could not load sample')
    }
  }, [])
}
