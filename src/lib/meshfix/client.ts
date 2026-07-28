/**
 * Client for the optional local `meshfix` repair service (tools/meshfix).
 *
 * Stepper stays a fully static app: if the service is not running, everything
 * keeps working through the in-browser pipeline. When it *is* running, a mesh
 * can be routed through it first to get a guaranteed watertight, 2-manifold,
 * self-intersection-free solid — which is exactly the precondition the
 * faithful planarisation path needs to produce an exact, economical STEP.
 *
 * Deployment note: a page served over https may only call `http://localhost`
 * because localhost counts as a potentially trustworthy origin. Chromium
 * honours that; Firefox and Safari have historically blocked it. The reliable
 * setup is `meshfix serve --serve-app dist`, which serves this app and the API
 * from one origin. `detect()` therefore never throws — a blocked request is
 * indistinguishable from "not running", and both mean the same thing here.
 */

export const DEFAULT_MESHFIX_URL = 'http://127.0.0.1:8787'

export interface BackendAvailability {
  available: boolean
  reason: string
}

export interface MeshfixHealth {
  service: string
  version: string
  backends: Record<string, BackendAvailability>
  max_upload_bytes: number
}

/** The criteria block of a meshfix report (A1..A10). */
export interface MeshfixCriterion {
  active: boolean
  passed?: boolean | null
  value?: unknown
  threshold?: unknown
  reason?: string
}

export interface MeshfixDiagnosis {
  n_vertices: number
  n_faces: number
  is_watertight: boolean
  is_winding_consistent: boolean
  n_components: number
  n_boundary_edges: number
  n_nonmanifold_edges: number
  n_nonmanifold_vertices: number
  n_selfintersecting_faces: number
  n_degenerate_faces: number
  shell_score: number
  verdict: 'printable' | 'repairable' | 'severe' | 'shell'
  volume: number | null
}

export interface MeshfixReport {
  accepted: boolean
  criteria: Record<string, MeshfixCriterion>
  input: { diagnosis: MeshfixDiagnosis }
  output: { diagnosis: MeshfixDiagnosis } | null
  backend: { selected: string | null; attempts: unknown[] }
  metrics: Record<string, number | boolean | null>
  warnings: string[]
}

export interface RepairResponse {
  report: MeshfixReport
  /** null when the service refused (e.g. an open shell) or produced nothing. */
  stl: ArrayBuffer | null
  refused?: string
}

export interface RepairOptions {
  voxelResolution?: number
  seal?: number
  shellThickness?: number
  expectedComponents?: number
  maxDeviation?: number
  seed?: number
  signal?: AbortSignal
}

/**
 * Probe for the service. Resolves to null when it is absent, blocked by mixed
 * content, or not answering — the caller treats all three identically.
 */
export async function detect(
  baseUrl: string = DEFAULT_MESHFIX_URL,
  timeoutMs = 1200,
): Promise<MeshfixHealth | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal })
    if (!res.ok) return null
    const health = (await res.json()) as MeshfixHealth
    return health.service === 'meshfix' ? health : null
  } catch {
    // Not running, or the browser blocked the call. Same outcome for us.
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

function buildQuery(options: RepairOptions): string {
  const query = new URLSearchParams()
  if (options.voxelResolution !== undefined) query.set('voxel_resolution', String(options.voxelResolution))
  if (options.seal !== undefined) query.set('seal', String(options.seal))
  if (options.shellThickness !== undefined) query.set('shell_thickness', String(options.shellThickness))
  if (options.expectedComponents !== undefined) query.set('expected_components', String(options.expectedComponents))
  if (options.maxDeviation !== undefined) query.set('max_deviation', String(options.maxDeviation))
  if (options.seed !== undefined) query.set('seed', String(options.seed))
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

async function post(
  baseUrl: string,
  route: string,
  stl: ArrayBuffer,
  options: RepairOptions,
): Promise<RepairResponse> {
  const res = await fetch(`${baseUrl}${route}${buildQuery(options)}`, {
    method: 'POST',
    // This exact content type is what forces a CORS preflight, which is part
    // of how the service protects itself from arbitrary pages.
    headers: { 'Content-Type': 'application/octet-stream' },
    body: stl,
    signal: options.signal,
  })
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new Error(`meshfix: ${detail}`)
  }
  const body = (await res.json()) as {
    report: MeshfixReport
    stl_base64: string | null
    refused?: string
  }
  return {
    report: body.report,
    stl: body.stl_base64 ? decodeBase64(body.stl_base64) : null,
    refused: body.refused,
  }
}

/** Repair a mesh, returning the repaired STL plus the full criteria report. */
export function repair(
  stl: ArrayBuffer,
  options: RepairOptions = {},
  baseUrl: string = DEFAULT_MESHFIX_URL,
): Promise<RepairResponse> {
  return post(baseUrl, '/api/repair', stl, options)
}

/** Diagnose only: same criteria, no mesh returned and nothing modified. */
export function diagnose(
  stl: ArrayBuffer,
  options: RepairOptions = {},
  baseUrl: string = DEFAULT_MESHFIX_URL,
): Promise<RepairResponse> {
  return post(baseUrl, '/api/diagnose', stl, options)
}

/** Criteria that failed, as short ids like `A5_no_selfintersection`. */
export function failedCriteria(report: MeshfixReport): string[] {
  return Object.entries(report.criteria)
    .filter(([, c]) => c.active && c.passed === false)
    .map(([id]) => id)
}
