# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Stepper** is a single-page web app that converts an arbitrary input mesh
(STL/OBJ/GLTF/GLB) into a watertight engineering solid and exports it to **STEP
(ISO 10303-21, AP214)** and STL. It reuses the 3D environment, design system,
mesh loaders and voxel *slicer* from the sibling **Optimizer** repo.

See `README.md` for the user-facing overview.

## A surface is not a solid (`src/lib/geometry/shell.ts`)

Checked **after `repairMesh`, not before** — see the ordering note below.
`diagnoseShell` welds by position (an STL soup shares no indices, so an
un-welded edge census reads either "every edge is a boundary" or "none is"),
counts single-use edges, and asks first whether the surface bounds anything:
`|V| / A` is the wall it already implies, and above `MIN_RELATIVE_WALL` (0.1% of
the diagonal) it is a solid, full stop. Only a surface bounding *nothing* is
scored by the isoperimetric quotient `1 - 6*sqrt(pi)*|V| / A^1.5`, at or above
`SHELL_SCORE_THRESHOLD` (0.9).

Closedness alone cannot decide this, in either direction. A thin-walled part is
as extreme on the quotient as a sheet — that is what thin-walled means — so the
score would ask a 1.2 mm moulded case for a wall it already has and then add it
twice. And once the repair runs first, a sheet whose rim it capped is *closed*
while still bounding nothing, so "closed ⇒ solid" fails the other way. The
implied wall separates both cases and the gap either side is wide.

So `convertMeshToSolid` refuses: with `shellThickness === 0` it returns an empty
solid plus the diagnosis, and the UI asks for the wall. Solidifying anyway would
return a plate exactly one voxel thick, which looks like a conversion bug and is
really an impossible question answered with an invented number. `tools/meshfix`
takes the same position (criterion A10).

With a wall, `thickenShell` offsets ±t/2 along angle-weighted vertex normals and
closes the rim. Two details are load-bearing: the offset is **mitred** by
`1/cos` (stepping along an *averaged* normal clears each incident face by only
`t/2 * cos`, so an unmitred wall is 37% thin at a fold), capped at `MAX_MITER`
2.0 just above a cube corner's `sqrt(3)` so a fold cannot fire a spike; and the
rim band keeps each boundary edge in its **owning face's direction**, since
sorting the edge to count its uses discards the winding and the band then
cancels its own volume. Welding before thickening must pass `fillHoles: false` —
a sheet's outer boundary is a legitimate 32-edge "hole", and capping it leaves
nothing to thicken. A walled surface is usually a closed manifold, so it takes
the **exact** path, not voxels.

## Core idea: faithful planar merge first; reconstruct only to repair

`src/lib/geometry/convert.ts::convertMeshToSolid` picks a method:

- **`faithful` (default)** → `planarizeMesh` (`src/lib/geometry/planarize.ts`).
  Merges coplanar, edge-adjacent triangles (union-find over the dual edge graph)
  into large planar faces, extracts each region's boundary loops, and simplifies
  out collinear NON-corner vertices (a vertex touching ≥3 regions is a corner and
  is kept, so shared edges between faces stay consistent → closed shell). NO
  resampling: output geometry equals the input surface. A box → 6 faces; `m2.stl`
  → 129 faces from 516 triangles. Requires a closed 2-manifold input; otherwise
  it auto-falls back to voxel reconstruction, then planarises the repaired shell.
  Knob: `planarToleranceDeg` (coplanar merge angle).
  `repairMesh` (`src/lib/geometry/meshRepair.ts`) runs **first, for every
  method**, and its result is what shell detection and conversion both see:
  weld → drop degenerate/duplicate → stitch T-junctions → drop double-diagonal
  overlaps → orient each component consistently and flip it outward by signed
  volume → ear-clip-fill boundary holes. If that yields a closed 2-manifold the
  faithful path planarises exactly; otherwise it solidifies.

  Two properties are load-bearing. It **iterates**: dropping an overlap opens a
  hole, filling that hole can leave a patch overlapping something else, and only
  the next pass sees it — the reference model goes 84 non-manifold + 16 open →
  7+9 → 5+0 → 1+0 → closed. And a pass is adopted **only when it leaves fewer
  defects**, because iterating without that test regresses a capped flat sheet
  from closed back to four open edges.

  `recutDoubleDiagonalQuads` handles a defect real exporters emit: two coplanar
  triangles hinged on a shared edge with their apexes on the same side are one
  quad cut on *both* diagonals — they overlap over half of it and leave the rest
  open. Dropping the pair and letting the hole filler rebuild beats re-cutting
  it, which orphans the neighbours of the edge it drops. It only ever inspects
  edges with 3+ owners, so it cannot touch a valid mesh.
- **`voxel` / `smooth`** → robust reconstruction, to *repair* broken meshes.
  Volume is defined by `solidifyToOccupancy` (`src/lib/geometry/solidify.ts`),
  NOT the fragile even-odd scanline: dense point-sample the surface into a
  PADDED grid (`paddedGridFor`, half-voxel-shifted so axis-aligned faces land at
  voxel centres) → dilate by `seal` to bridge cracks → flood-fill outside from
  the border → solid = unreached voxels, eroded back by `seal`, then `makeManifold`
  fills only the diagonal voxel gaps that would make the cuberille non-manifold
  (flat faces stay flat). Then `occupancyToSolid` (cuberille, planarised) or
  `marchingCubesFromVoxelDensity` + `taubinSmoothBounded`.

`convertMeshToSolid` returns BOTH a triangulated `solid` (viewport + STL) and a
polygonal `brep` (economical STEP; null for `smooth`). `isWatertight` (every
undirected edge used by exactly two triangles) is the honest check; the faithful
path reports `faithful: true`, reconstruction reports `reconstructed: true`.

## Ported-from-Optimizer modules (do not diverge casually)

`src/lib/geometry/{sliceFrame,sliceVoxelize,slicedSolid,hexFaces,marchingCubes,marchingCubesTables}.ts`,
`src/lib/stl/{parseSTL,exportSTL}.ts`, `src/lib/loaders/*`, and
`src/components/viewer/bvh.ts` are copied from Optimizer with import paths
adjusted. `boundingBox.ts` is a slimmed local copy (AABB helpers only, no
project-type deps). Keep these in sync with Optimizer when fixing bugs.

One deliberate divergence: `sliceFrame.ts::computeGrid` clamps the layer to
`cellSize / MAX_VOXEL_ASPECT` (64). Surface sampling steps at half the smallest
voxel dimension and its cost grows as the inverse square, so a flat input — which
falls to the 1e-9 extent floor — does not produce a bad grid, it produces one
that never finishes.

## STEP exporter invariants (`src/lib/step/exportSTEP.ts`)

- One shared core `emitStep(vertices, StepFace[])` drives two entry points:
  `exportSTEP(vertices, indices)` (one planar face per triangle — verbose
  fallback) and `exportSTEPFromFaces(vertices, faces)` (merged planar faces from
  `planarizeMesh` — the economical path the UI uses via `downloadSTEP`).
- Output is a full AP214 `ADVANCED_BREP_SHAPE_REPRESENTATION` → `MANIFOLD_SOLID_BREP`
  → `CLOSED_SHELL` of planar `ADVANCED_FACE`s (a `FACE_OUTER_BOUND` plus
  `FACE_BOUND` holes), plus the product/context boilerplate so all CAD tools
  import it.
- **Vertices and edges are shared.** `weldMesh` collapses coincident vertices;
  each undirected edge becomes ONE `EDGE_CURVE`, referenced by exactly two
  `ORIENTED_EDGE`s with opposite sense. The test in `tests/unit/exportSTEP.test.ts`
  asserts this 2-per-edge invariant — it is what makes the shell closed.
- **Reals must not use lowercase-`e` exponent form** (invalid for strict STEP
  parsers). `num()` uses fixed 6-decimal notation; a test guards against `e`.
- Unit is hard-coded millimetres.

## STEP importer (`src/lib/step/parseSTEP.ts`) — the reverse direction

`parseSTEP(text)` reads the DATA section into `#id → TYPE(args)` entities with a
quote-aware splitter (strings may contain `,`/`(`/`)` and `''` escapes), then walks
`ADVANCED_FACE`/`FACE_SURFACE` → bounds → `EDGE_LOOP` (via `ORIENTED_EDGE` →
`EDGE_CURVE`, honouring `.T./.F.` sense) or `POLY_LOOP`, and ear-clips each face
polygon in its plane (`triangulateFace`, holes supported). Output is a
non-indexed triangle soup, same shape as `parseSTL`, so `load3DFile` treats
`.step`/`.stp` like any other input format. Planar B-reps (including Stepper's own
exports) round-trip exactly — see `tests/unit/parseSTEP.test.ts`, which checks
volume, AABB and watertightness after re-welding. Curved surfaces are only
approximated by their edge-vertex polygon (no NURBS evaluation).

## State & UI

- One zustand store: `src/state/converterStore.ts` (input mesh, settings, result,
  view toggles).
- `useConversion` recomputes the solid (debounced, deferred) whenever the mesh or
  settings change. Conversion is synchronous — if it becomes a bottleneck on big
  grids, move `convertMeshToSolid` into a worker.
- Viewer (`src/components/viewer/Viewer.tsx`) is a lean R3F canvas showing the
  original (ghost wireframe) and the converted solid; it is NOT the heavy
  Optimizer Scene (which is tied to FEM/region/BC domain state).

## meshfix in the browser (`src/workers/meshfix.worker.ts`)

Opt-in deep repair, CPython-on-wasm via Pyodide. It calls
`meshfix.serve._process` — the **same** entry point as `meshfix serve` — and the
`.py` files are bundled from `tools/meshfix/meshfix/` with `import.meta.glob`
and written into the wasm filesystem, so there is one implementation of the
criteria, not a TypeScript re-derivation that drifts. `src/lib/meshfix/browser.ts`
fronts the worker with the same `RepairResponse` shape as the HTTP client.

Load-bearing details, all carried over from Optimizer, which hit each in
production first: Pyodide's distribution is **self-hosted** under
`public/pyodide/` (`scripts/vendor-pyodide.mjs`, run by `pnpm build`) because the
npm package derives `indexURL` from its own module location, which Vite
relocates; the numpy/micropip **wheels must move too**, since `pyodide-lock.json`
names them relative to that same `indexURL`; `worker: {format: 'es'}` because
Pyodide's graph needs code-splitting; `optimizeDeps: {exclude: ['pyodide']}` for
the dev server only.

`alphawrap` is a native binary and is absent in the browser — the chain is
`voxel` alone. Verification, not repair, is the cost there: the backend runs in
about a second while A5 over the cuberille output takes 15–99 s depending on
grid (NOTES.md §11.2), which is why the panel passes the conversion grid
straight through rather than multiplying it.

## Conventions

- Design tokens in `tailwind.config.ts` + `src/index.css` (copied from Optimizer):
  `surface-0..5`, `ink-1..5`, `line`, semantic `accent/success/warning/danger`.
  Icons via `lucide-react`, never emoji.
- Path alias `@/` → `src/`.
- Gates: `pnpm typecheck`, `pnpm test`, `pnpm build` must stay green.

## Branching

Active branch: `claude/3d-to-step-converter-7borlp`. Remote `przemeknowak781/stepper`.
Push only to the assigned branch.
