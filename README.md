# Stepper — 3D → STEP converter

Stepper turns an arbitrary input mesh (**STL / OBJ / GLTF / GLB**) into a clean,
watertight **engineering solid** and exports it to **STEP (ISO 10303-21, AP214)**
— ready to open in FreeCAD, Fusion, SolidWorks, or any CAD package, and to STL.

It converts **both directions**: drop a **STEP/STP** file and it is imported as a
mesh (`src/lib/step/parseSTEP.ts` reads the B-rep topology — shells → faces →
loops → vertices — and triangulates each face in its plane), so STEP → STL works
as well as mesh → STEP. Planar/faceted B-reps import exactly; curved surfaces are
approximated by the polygon through their edge vertices.

It reuses the 3D environment, design system, mesh loaders and the
voxel *slicer* from the sibling **Optimizer** project.

## Surfaces need a wall thickness

Plenty of files that look like parts are not solids: an open surface exported
from a surface modeller, a scan, or a generative model encloses no volume, and
there is no correct solid for one until you say how thick the wall should be.

A part that *already has* a wall is not one of these, even when its surface is
broken. Stepper repairs first and then asks whether what it has bounds a volume,
because a 1.2 mm moulded skin looks exactly like a sheet to any thinness measure
— and a model a few broken faces away from closed should be closed, not
inflated. The reference test model is one of these: 84 non-manifold edges and 16
open ones from a malformed side wall in the source file, repaired to a closed
manifold and exported as 296 exact planar faces.

For a genuine surface, Stepper **asks** rather than guessing. Give it
a wall and it offsets the surface symmetrically, closes the rim, and converts the
result — usually along the exact path, since a walled surface is a closed
manifold. Leave it unset and nothing is exported, with the reason stated: a
solid built without your number would be an arbitrary thickness, not yours.

The alternative is what most converters do — solidify anyway and return a plate
one voxel thick, stair-stepped and nothing like the input. That looks like a
conversion bug. It is really an impossible question answered with an invented
number.

## Deep repair, in the browser

Some meshes are beyond a topological fix — heavy self-intersection, dozens of
loose components, windings that disagree. For those, Stepper can run the full
`meshfix` criteria (A1–A10) in the browser on CPython compiled to WebAssembly,
and rebuild a guaranteed watertight, 2-manifold, intersection-free solid.

It is opt-in: the runtime is a ~16 MB one-time download and takes a few seconds
to boot, so nothing is fetched until you click. The same tool also runs
natively from `tools/meshfix` — as a CLI, or as a local service Stepper talks
to — and both routes call the same Python entry point, so they agree by
construction rather than by review.

Building `tools/meshfix/scripts/build_aw3.sh` adds CGAL alpha wrapping to the
native paths, which follows the surface instead of quantising it: on the test
model, 5 794 faces against the voxel backend's 120 024, and closer to the input.

## Conversion: faithful first, reconstruct only when forced

The goal is an **excellent, economical, exact** solid — not a heavy
approximation. A 12-triangle box must come out as a 6-face box, not a blob of
thousands of facets. Stepper has three methods:

### `faithful` (default) — mesh → B-rep, no resampling

`planarizeMesh` merges the input's **coplanar, edge-adjacent triangles** into
large planar faces and drops the redundant collinear vertices from each face's
boundary. Nothing is resampled, so the output geometry is **bit-identical to the
input surface** while a flat region made of hundreds of triangles collapses to a
single polygon. Real numbers: the reference `m2.stl` goes from **516 triangles →
129 exact planar faces** (and down to 7 with a looser tolerance). A box → 6
faces / 12 edges / 8 vertices, exactly.

The one knob is the **planar tolerance** (degrees): 0° keeps every distinct
plane; raising it merges gently-curved regions into fewer planar faces (a
deliberate approximation you control). This path needs a clean closed manifold.

### `voxel` / `smooth` — reconstruction, to *repair* broken input

Meshes from scanners or sculpting tools are often not valid solids (holes,
non-manifold edges, self-intersections, flipped normals). When the faithful path
detects a non-manifold input it automatically falls back to voxel
reconstruction; you can also pick it explicitly:

1. **Voxelise** — rasterise into an occupancy grid via the Optimizer slicer
   (`sliceAndVoxelize`, even–odd scanline fill).
2. Rebuild a fresh watertight surface: **voxel** (`occupancyToSolid` cuberille,
   then planarised so the flat sides merge into big rectangles) or **smooth**
   (`marchingCubesFromVoxelDensity` + feature-preserving Taubin smoothing).

Because the surface is regenerated around the filled volume, the result is
**watertight and 2-manifold by construction** — input defects disappear. Grid
resolution trades fidelity for weight.

The app reports whether the output is exact (faithful) or was reconstructed, its
STEP face/edge/vertex counts, and any open regions that had to be sealed.

## STEP export

`src/lib/step/exportSTEP.ts` emits a full AP214 `ADVANCED_BREP_SHAPE_REPRESENTATION`:
a `MANIFOLD_SOLID_BREP` whose `CLOSED_SHELL` has one planar `ADVANCED_FACE` per
triangle. Vertices and edges are **shared** between adjacent faces (each edge is
one `EDGE_CURVE` referenced by two oppositely-oriented `ORIENTED_EDGE`s), so CAD
tools import it as a real solid body. Unit is millimetres.

## Stack

Vite 5 · React 19 · TypeScript 5 (strict) · @react-three/fiber + three r170 ·
three-mesh-bvh · zustand · Tailwind 3.

```
pnpm install
pnpm dev        # dev server
pnpm test       # vitest (STL round-trip, watertight conversion, STEP validity)
pnpm typecheck
pnpm build
```

## Layout

```
src/lib/geometry/   slicer + reconstruction (ported from Optimizer) + convert.ts
src/lib/step/       STEP AP214 exporter
src/lib/stl/        binary/ASCII STL parse + write
src/lib/loaders/    STL/OBJ/GLTF/GLB loading
src/lib/meshfix/    clients for meshfix: local service + in-browser worker
src/workers/        meshfix on Pyodide (lazy, opt-in)
src/state/          zustand converter store
src/hooks/          upload, sample, debounced conversion
src/components/     R3F viewer + control / export / repair panels
tools/meshfix/      the Python repair tool (CLI, service, CGAL alpha wrap)
```

## Deployment (GitHub Pages)

Pushing to `main` runs `.github/workflows/deploy.yml`, which builds with
`VITE_BASE=/stepper/` and publishes `dist/` to GitHub Pages. The app is fully
static — no server needed.

**One-time setup (repo admin, required once):** open
**Settings → Pages → Build and deployment → Source** and select
**GitHub Actions**. The Actions token cannot create the Pages site itself on
this account (it fails with *"Resource not accessible by integration"* until
Pages is turned on by hand). After enabling it, re-run the latest
*Deploy to GitHub Pages* workflow (Actions tab → Run workflow) or push any commit
to `main`.

Live URL after the first successful deploy:
**https://przemeknowak781.github.io/stepper/**

If the repository is ever renamed, update `VITE_BASE` in the workflow (and the
`base` fallback in `vite.config.ts`) to `/<new-name>/`.
