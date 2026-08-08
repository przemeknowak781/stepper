# NOTES

Decisions the specification left to the implementer (SPEC 13), deviations from
it, and library API surprises. Everything here is a decision actually taken in
code, not a plan.

---

## 1. Self-intersection test: own AABB implementation (SPEC 13.1)

**Decision: implemented in-house**, in `meshfix/diagnose.py`
(`self_intersecting_faces`), not delegated to PyMeshLab.

Reason: PyMeshLab is a *soft* dependency (SPEC 12), needed only for the
`poisson` backend. The core diagnosis must work without it, and A5 is a hard
criterion — a hard criterion cannot depend on an optional package.

Implementation: uniform spatial hash over per-face bounding boxes (broad
phase), then Möller's triangle-triangle overlap test with a coplanar SAT
fallback (narrow phase). Pairs sharing a vertex are excluded, because adjacent
triangles always touch along their shared edge and that is not a defect.

### Performance budget — now met (was a stated gap)

SPEC 13.1 sets a budget of "under 30 s at 500k triangles". The first version
ran one Python-level Möller call per candidate pair and extrapolated to about
**3 minutes**, roughly 6× over. That gap is closed; the routine moved to
`meshfix/selfintersect.py` and gained a vectorised rejection stage.

Candidate pairs are now built with fully vectorised bucket insertion (spans
decoded via `repeat`/`cumsum` rather than a triple loop per face), deduplicated
by packing each pair into one int64 — `np.unique(axis=0)` does a lexicographic
row sort and dominated the profile — and then filtered by four numpy stages
before any Python runs: shared-vertex adjacency, bounding-box overlap, and each
triangle straddling the other's plane.

Measured after the change:

| mesh | faces | time | rate |
|---|---|---|---|
| `ai_like_blob` | 1 549 | 0.07 s | (was 0.5 s) |
| noisy sphere | 81 920 | 3.2 s | 26k faces/s |
| noisy sphere | 327 680 | 15.3 s | 21k faces/s |
| two noisy spheres | **655 360** | **33.7 s** | 19.4k faces/s |

655k faces in 33.7 s is 19.4k faces/s, so 500k lands at **~26 s — inside the
30 s budget**. Results are unchanged on every fixture (324, 106, 12 and 0
intersecting faces respectively), which is what the tests pin.

A caveat on benchmark honesty: an earlier measurement showed severe superlinear
decay (4k faces/s at 327k). It used noise *larger than the triangles*, which
turns the mesh into a dense tangle where the pair count really is quadratic.
The table above perturbs vertices by 30% of mean edge length, which is what a
scan or generative model actually produces.

---

## 2. Hausdorff distance: sampling + cKDTree (SPEC 13.2)

**Decision: sampling plus `scipy.spatial.cKDTree`**, not PyMeshLab — same
soft-dependency argument as above, plus it is materially faster.

Consequence: the result is an **estimator**, so the report carries
`hausdorff_approximate: true` (SPEC 9). Sampling is driven by an explicit
`numpy.random.Generator` seeded from `--seed`, never by global RNG state
(SPEC 12.1). Implemented in M2.

### 2.1 The estimator has a noise floor, and the default A8 threshold can sit under it

Two point sets drawn independently on the *same* surface still lie roughly one
inter-sample spacing apart, so the estimate never reaches zero. Its floor is
about `sqrt(area / n_samples)`.

Measured: comparing `clean_cube` (edge 10, area 600) with itself at 20 000
samples gives a two-sided Hausdorff of ~0.17, matching the predicted floor.

This collides with the default threshold. `--max-deviation` defaults to 0.5% of
the bounding-box diagonal, which for that cube is **0.087** — below the floor.
At that sampling density A8 would fail on a perfect copy of the input.

Handling:
* `compare()` returns `hausdorff_noise_floor` and the report carries it, so a
  threshold can always be read against the resolution that produced it.
* `DEFAULT_SAMPLES` is 50 000. Keeping the floor under a threshold of
  `0.005 * diag` requires roughly `area / (0.005 * diag)**2` samples — about
  80 000 for the cube — so the default is deliberately generous and still not
  universally sufficient.
* Open item for M3: have the CLI emit a warning when
  `max_deviation < hausdorff_noise_floor`, since in that regime A8 is
  measuring sampling noise rather than geometry.

### 2.2 Empirical confirmation that A8 had to become two-sided (change C1)

Constructed case: a 10-cube with a 1-wide, 6-deep slot, compared against the
same cube with the slot filled in — the canonical alpha-wrapping failure.

| direction | value |
|---|---|
| `in->out` | **4.507** (the swallowed slot) |
| `out->in` | 0.542 (nothing protrudes) |
| noise floor | 0.187 |

Spec version 1.0 gated on `out->in`, so it would have reported 0.54 against a
default threshold of 0.087·… — and, more importantly, would have ranked this
output as barely different from the original while 4.5 units of geometry went
missing. The test `test_directions_differ_when_detail_is_lost` pins this.

---

## 3. Threshold calibration (SPEC 13.3)

### 3.1 `severe` thresholds — kept as specified

The version 1.1 values (`selfintersect > 5% of faces`, `components > 20`,
`nonmanifold_edges > 2% of faces`) classify every fixture as intended, so they
stand unchanged.

One caveat worth recording: ratio thresholds are meaningless on very small
meshes. `degenerate_slivers` (14 faces) classifies as `severe` because 12 of
its faces are flagged as self-intersecting — the zero-area slivers lie exactly
in the plane of the cube's faces, so the coplanar test reports them. The
classification is not wrong (the mesh really is badly broken), but the *ratio*
did no work; an absolute floor would be more honest if this ever matters for
routing. It does not today: both `severe` and `repairable` try `alphawrap`
first.

### 3.2 `shell_score` formula — CHANGED during calibration

The formula written into SPEC 1.1 §5.3 was

```
shell_score = max(min(1, 4 * boundary_ratio), thinness)
```

Calibration on the fixtures showed it to be wrong in two independent ways, and
it was replaced by

```
shell_score = 0.0                if the mesh is closed (no boundary edges)
shell_score = thinness           otherwise
```

**Why `boundary_ratio` was dropped.** It measures tessellation density, not
shell-ness, and on the exact pair it has to separate the signal is *inverted*:

| fixture | boundary edges / edges | what it is |
|---|---|---|
| `open_shell` | 80 / 1240 = **0.065** | a genuine sheet |
| `open_cube` | 4 / 18 = **0.22** | a chunky solid missing one face |

A finely tessellated shell has a *low* boundary ratio. With the gain of 4,
`open_cube` scored 0.89 and was refused as a shell, which would have blocked a
perfectly repairable model.

**Why closed meshes are now forced to 0.** On a closed mesh the divergence
volume is corrupted by inconsistent winding, so `flipped_normals` — a solid
sphere whose only defect is 30% reversed faces — scored 0.60 on thinness and
was misclassified as a shell. A closed mesh encloses volume by definition;
whether that volume is thin is A9's question, not A10's. This also fixes
`thin_shell` (a 0.2-thick closed plate), which correctly reads as a solid that
will fail A9, rather than as a shell.

Resulting classification across all fixtures:

| fixture | shell_score | verdict |
|---|---|---|
| `clean_cube` | 0.00 | printable |
| `open_cube` | 0.05 | repairable |
| `nonmanifold_edge` | 1.00 | shell |
| `bowtie_vertex` | 0.00 | repairable |
| `selfintersect_torus` | 0.00 | severe |
| `flipped_normals` | 0.00 | repairable |
| `degenerate_slivers` | 0.28 | severe |
| `two_components` | 0.00 | printable |
| `open_shell` | 1.00 | shell |
| `thin_shell` | 0.00 | printable |
| `ai_like_blob` | 0.36 | severe |

---

## 4. Deviations from the specification

### 4.1 `nonmanifold_edge` classifies as `shell`, not `repairable`

SPEC 10.1 expects this fixture to reach "A2 passes after repair". It is three
triangles sharing one edge: zero enclosed volume and an open boundary, so
`shell_score = 1.0` and A10 refuses it before any backend runs.

**This is kept deliberately.** Three triangles cannot become a solid without
someone deciding how thick they should be, and inventing that thickness is
exactly the silent failure A10 was added to prevent (SPEC 5.3). Running it with
`--shell-thickness T` proceeds normally. The fixture still earns its keep: it
is the only input that exercises non-manifold *edge* counting.

### 4.2 Exact vertex welding happens at load time

`meshfix.io.load_mesh` merges **bit-identical** vertices before returning.

This looks like it violates "loading must not silently repair", so the
reasoning is recorded: binary STL stores three independent vertices per
triangle and cannot express sharing at all. Without welding, a correct cube
read back from STL reports 12 connected components, 36 boundary edges and
`is_watertight = False` — the diagnosis would describe the *file format*, not
the model. Recovering that connectivity is decoding, not repair.

The line is drawn at exactness: only bit-identical coordinates merge. Merging
vertices that are merely *close* is a genuine repair, is governed by an
explicit tolerance, and belongs to `postprocess` (M5). `n_duplicate_vertices`
in the diagnosis therefore counts near-duplicates at the postprocess tolerance
`max(diag * 1e-8, ulp_float32(diag))`, which is the number that predicts how
much work that weld will do.

---

## 5. Library API corrections (SPEC 0)

Verified against the installed versions rather than trusted from memory.

| Spec/assumed | Actual (trimesh 4.12.2) | Note |
|---|---|---|
| `trimesh.graph.connected_components(edges, node_count=N)` | `connected_components(edges, min_len=1, nodes=None, engine=None)` | `nodes=` takes the node array. Passing every face index keeps isolated faces, which have no adjacency entry and would otherwise vanish from the component count. |

`trimesh.creation.torus(major_radius=, minor_radius=, major_sections=,
minor_sections=)` exists and is used as written.

PyMeshLab is not installed in this environment, so no filter names have been
verified yet. That verification is a prerequisite for M6 and must happen
before any `pymeshlab` call is written.

---

## 6. Fixture correction

`selfintersect_torus` originally used two *interlocked* (perpendicular) tori,
which look like they must intersect and do not. With major radius 5 and minor
radius 1.5, the two centre circles never come closer than 5 units, well beyond
the combined tube radius of 3 — the diagnosis correctly reported zero
self-intersections and the fixture tested nothing.

Replaced with two **coplanar** tori whose centres are 6 apart. Their centre
circles (radius 5 each) genuinely cross, so the tubes must intersect; the test
now reports 324 self-intersecting faces.

---

## 7. Dependencies

`pymeshlab` was moved from hard to soft in SPEC 1.1 and the core honours that:
nothing in `io`, `diagnose`, `validate`, `metrics` or `report` imports it.

`rtree` is installed as a dev/test extra only; it is not imported directly and
becomes relevant for accelerated ray casting.

### One addition beyond SPEC 12, test-only: `manifold3d`

`trimesh.boolean` needs a backend, and there is none in a bare install. It is
used in exactly one place — `test_directions_differ_when_detail_is_lost` — to
*construct* the slotted-box fixture that demonstrates the A8 asymmetry.

It is declared under the `dev` extra, never imported by library code, and the
package works without it. The alternative was hand-triangulating a U-shaped
prism inside a test, which would put a second, untested ear-clipping
implementation into the repository to avoid a well-maintained wheel.


---

## 8. Running in the browser via Pyodide

Verified rather than assumed: the whole package runs **unmodified** under
Pyodide (CPython compiled to WebAssembly), including file I/O on its in-memory
filesystem and the full backend orchestration.

`trimesh` ships zero C extensions, so `micropip.install("trimesh")` works
straight from PyPI; numpy is a first-class Pyodide package.

### Measured, CPython 3.11 (x86) against Pyodide 0.28 (wasm)

| | CPython | Pyodide |
|---|---|---|
| `analyze(ai_like_blob)` | 0.48 s — `selfX=106 nmV=6` | 0.91 s — identical |
| voxel repair | 0.94 s — 60 112 faces | 1.59 s — identical |
| two-sided Hausdorff | 0.309286247785344 | 0.3093 (agrees to shown precision) |
| full `run_chain` on MEMFS | — | accepted, watertight, 0 non-manifold |

So roughly **1.8× slower** on the vectorised paths, which is fine, and the
topological results are identical.

**Determinism caveat.** Agreement was checked to displayed precision and on
exact face counts, *not* bit-for-bit. Change C7 already limits the determinism
guarantee to a fixed build, and wasm is a different build; no stronger claim is
made.

### Payload, and why scipy had to go

| component | size |
|---|---|
| `pyodide.asm.wasm` | 9.2 MB |
| `python_stdlib.zip` | 2.4 MB |
| numpy | 2.8 MB |
| **scipy** | **13.4 MB (48%)** |
| micropip + trimesh | ~1.7 MB |
| **total** | **~28 MB** uncompressed |

scipy alone was nearly half the download for what turned out to be *three*
features. `meshfix/nputil.py` replaces them in numpy — 6-connected dilation/erosion, a sweep-based flood fill
standing in for `label` plus border selection, and an exact nearest-neighbour
query standing in for `cKDTree`. scipy stays a **test** dependency so
`tests/test_nputil.py` can assert equivalence.

**A third, hidden dependency surfaced only by testing.** Blocking `scipy` at
the import hook — the honest way to check the claim — revealed that
`trimesh.graph.connected_components` raises "no graph engines available!"
unless SciPy or NetworkX is importable. Component counting is part of criterion
A7, so SciPy would have come back through the side door and undone the whole
saving. `connected_component_labels` now does it with hooking plus pointer
jumping: about log(n) fully vectorised rounds, verified against trimesh's own
answer where SciPy *is* present.

One trace remains and is harmless: `trimesh.geometry.weighted_vertex_normals`
attempts `scipy.sparse`, logs a traceback, and falls back to its dense path.
Only `postprocess.thicken_shell` touches it, and the result is correct.

Two bugs found while writing the replacements, both worth recording:

1. **Cell size must respect effective dimensionality.** Sizing the
   nearest-neighbour hash from bounding-box *volume* collapses to near zero for
   surface samples, which are a 2D sheet in 3D — and surface samples are the
   entire use case. The search then expanded over enormous radii and the test
   suite stopped terminating. `_characteristic_spacing` now uses only the
   extents that carry real variation and takes the d-th root over those.
2. **The shell-termination bound was off by one.** Having searched Chebyshev
   radius R, nothing unsearched can be nearer than `R*cell`, not
   `(R-1)*cell`; the conservative version never resolved anything at R=1 and
   searched far more shells than necessary.

`NearestPoints` is 8–12× slower than `cKDTree` (0.4–0.75 s for 50k×50k, versus
0.05 s) but exact, which is what A8 requires. Dropping 13.4 MB is worth it.

Without scipy the browser payload is **~15 MB** uncompressed, and the wasm
compresses well with brotli.

### Still to do before this ships in Stepper

Loading Pyodide must be lazy and confined to a worker, so the app stays instant
for users who never ask for repair. The sibling Optimizer repo already solves
the Vite integration — `worker: { format: 'es' }` because Pyodide needs
code-splitting, and `optimizeDeps: { exclude: ['pyodide'] }` because esbuild's
pre-bundler relocates `pyodide.mjs` but not the sibling assets it loads by
relative import, which then 404. Reuse those settings rather than rediscovering
them.

---

## 9. Open shells: three bugs one real model exposed

An open-shell model with 58 components, 67 boundary edges and a bounding box of
0.43 × 0.18 × **0.037** (`shell_score` 0.97) went the whole way through
`--shell-thickness` and came back rejected. Each layer of the rejection turned
out to be a separate defect, and all three were the same class of mistake:
a quantity judged against a reference that does not mean what the code assumed.

### 9.1 A5 flagged 27 771 of 71 920 faces on a cuberille

A cuberille cannot self-intersect: it is a union of axis-aligned voxel walls.
The parallel-plane test in `_tri_tri_intersect` compared the **unnormalised**
`n1 x n2` against a fixed `1e-12`. That quantity scales with the product of the
two triangle *areas*, so for voxels 0.0025 across (`|n| ~ 6e-6`) two exactly
**perpendicular** walls give `|n1 x n2|^2 ~ 1.3e-21` — read as "parallel", sent
to the coplanar overlap test, reported as intersecting. Every corner in the
model was a false positive.

Fixed by normalising the face normals first, which turns the parallel test into
an actual angle and the plane distances into actual lengths, then scaling the
distance tolerance by the size of the triangles being compared. The same
absolute epsilon was in the vectorised `_straddles` rejection stage.
`tests/test_diagnose.py::test_selfintersection_verdict_does_not_depend_on_model_scale`
runs the fixtures at 1e-3 and 1e3 scale, which is what would have caught it.
The input's own count corrected from 254 to 141 at the same time.

### 9.2 "volume_collapsed (output is -214% of the input volume)"

`mesh.volume` is the divergence integral over the faces and returns a number
for *any* surface, including an open sheet whose windings disagree. That number
is not a volume, and dividing by it produced the negative ratio above, which
then tripped the hollow-result warning on a perfectly good solid.

`_safe_volume` now returns `None` unless the mesh is watertight **and**
consistently wound. That silences the false warning but would also silence the
real check for exactly the inputs that most need it, so a thickened shell
supplies the reference it does have: sheet area times the requested wall. When
neither is available the report says the check was skipped, rather than
implying it passed.

### 9.3 Fidelity was measured against the wrong mesh

A8 compared the output to the *thickened* shell. Where a sheet folds tighter
than its new wall, the two offset copies pass through each other and end up
**inside** the solid rather than on its boundary — measured on this model, half
the sampled surface. Those points are correctly absorbed, but they read as
deviation, and the number did not converge with resolution (0.0082 at 200,
0.0078 at 700), which is the tell.

Fidelity now measures against the **original sheet**, which is the question
worth asking — does the solid follow the surface it came from — and the wall is
added to the budget, since it is deviation the user asked for. The deviation
then decomposes exactly: `MAX_MITER * thickness/2` for the offset envelope plus
about one voxel of discretisation.

### 9.4 And the wall was 37% thinner than requested

Found while fixing the above. Offsetting a vertex by `t/2` along an *averaged*
normal clears each incident face's plane by only `t/2 * cos`, so a thickened
open cube enclosed 15.7 rather than the exact 25.0 its area and thickness
imply. The offset is now mitred by `1/cos`, using the smallest cosine over the
incident faces so the wall is never *thinner* than asked — erring towards too
thick, which a solidifier absorbs, rather than too thin, which it can pinch
away. Exact 25.000125 on the open cube.

`MAX_MITER` is capped at 2.0, just above a cube corner's `sqrt(3)`, and the cap
is doing real work: at 4.0, 11.5% of this model's vertices sat at the cap, each
firing a spike four times the wall out of the model — which tripled the
Hausdorff deviation and broke A2 manifoldness. Beyond three mutually
perpendicular faces the vertex normal is not bisecting anything and extending
along it is guesswork.

### 9.5 Why none of this was caught

`thicken_shell` still called `trimesh.repair.fix_normals` and `mesh.vertex_normals`,
both of which route through trimesh's graph layer and refuse to run without
NetworkX or SciPy — the two dependencies §8 dropped. The path died with
`ModuleNotFoundError` the first time a real shell reached it, because **nothing
in the suite enforced the drop**. `tests/test_postprocess.py` now runs the
thickening path with both modules blocked from import.

---

## 10. Alpha wrapping (M4): the backend that made A5 honest

`cpp/aw3.cpp` + `scripts/build_aw3.sh` build a small CGAL binary; the backend
shells out to it. A separate process rather than a Python binding because CGAL's
own SWIG bindings do not expose `alpha_wrap_3`, and writing one would turn an
*optional* backend into a compile-time dependency of the whole tool. Absent
binary → `available()` returns the build hint, the chain falls through to
`voxel`, and the report says so (change C14).

Two implementation notes. The input is read as a polygon **soup**, not a mesh:
this backend is reached for files whose connectivity is broken, and requiring a
valid mesh to read them would refuse exactly what it exists to fix. And
`repair_polygon_soup` runs first, because an STL stores every triangle's corners
separately — without merging them the wrap has to rediscover the surface.

On the §9 model (walled to 0.01) it is decisive:

| backend | faces | verdict |
|---|---|---|
| voxel @ res 300 | 120 024 | accepted, A8 soft-failed at 0.0129 |
| **alphawrap** | **5 794** | **accepted, A8 passed at 0.0108** |

Same body, 20× fewer faces, and closer to the input — because a wrap follows the
surface where a cuberille quantises it.

### 10.1 It also exposed a second scale bug in A5

The wrap is *guaranteed* intersection-free, and meshfix reported 2 intersecting
faces in it. The pair sat **1e-11 apart** at coordinates near 0.1 — 700× below
the float32 spacing the STL round trip stores them at — and did not overlap in
plane at all.

Cause: coplanarity was decided from the angle between the normals alone
(`|n1 x n2| <= 1e-9`), and this pair came in at 3.1e-9, just missing it. The
crossing-chord branch then ran, where every vertex within `eps` of the other
plane counts as lying on it — so the "chord" became the triangle's whole extent,
and any two near-coincident triangles appeared to overlap.

Two changes. Coplanarity is now decided by the **distances** as well as the
angle: if every vertex of either triangle is within tolerance of the other's
plane, the chord math has no chord to find and the 2D overlap test answers
instead (correctly: no overlap). And the tolerance is floored at
`float32_ulp(coordinate)`, because an overlap shallower than one ulp is a
property of the file format, not the geometry — the same argument that floors
`weld_tolerance` (change C9).

Together with §9.1 this is the second time A5 was measuring something other than
the mesh. Both were absolute epsilons applied to scale-dependent quantities.

---

## 11. Running in the browser (Pyodide): what it actually took

Stepper loads meshfix in a Web Worker on CPython-to-wasm
(`src/workers/meshfix.worker.ts`). It calls `meshfix.serve._process` — the same
entry point the HTTP service uses — so the browser and the local service cannot
give different answers. Verified in headless Chromium against the §9 model: the
browser reports the identical diagnosis (67 boundary edges, 59 non-manifold,
147 self-intersecting, 80 degenerate, 58 components) and the identical seven
failed criteria.

The `.py` files are bundled as source and written into the wasm filesystem, so
there is one implementation of the criteria rather than a TypeScript
re-derivation that drifts. `alphawrap` is a native binary and is simply absent
there; the chain is `voxel` alone and the report says so.

### 11.1 A portability bug the 64-bit host could never show

`np.repeat` takes its counts as `intp`, which is **32 bits under Emscripten**.
Every repeat count in `_candidate_pairs` was int64 by default, so the broad
phase died with "cannot cast int64 to int32 safely" the first time it ran in
Pyodide, while passing on the host. Cast at the three sites that feed `repeat`.

### 11.2 Verification costs far more than repair

Measured on the §9 model, per resolution:

| grid | output faces | backend | `analyze(output)` | Hausdorff | total |
|---|---|---|---|---|---|
| 96 | 17 032 | 0.24 s | 14.6 s | 14.9 s | 30.5 s |
| 128 | 29 312 | 0.35 s | 26.0 s | 12.0 s | 38.7 s |
| 256 | 113 744 | 1.37 s | **98.9 s** | 12.1 s | 116.9 s |

The backend never exceeds 1.4 s. What dominates is A5 over the *output*, whose
face count grows with the cube of the resolution — a cuberille is face-heavy by
construction. Hausdorff is flat (a fixed 50 000 samples).

Consequence for the UI: the repair panel passes the conversion grid straight
through instead of the 4x it used to, and reports the elapsed time. On this
model that is 24 s instead of 113 s for the same accepted result. Special-casing
"a cuberille cannot self-intersect, skip A5" would be faster still and is
exactly the assumption SPEC 15 forbids — the backend does not get to certify its
own output, and §9.1/§10.1 are two reminders of what that check catches.

### 11.3 Payload

16 MB self-hosted under `public/pyodide/` (9.6 MB of it the wasm), plus a 0.7 MB
trimesh wheel, all fetched only after the user opts in — the worker chunk is
151 KB and the main bundle grew by 6 KB. Dropping SciPy (§8) is what keeps that
number where it is; with it the download would be roughly double.

---

## 12. A10 has the same blind spot Stepper just lost

Stepper found that its shell test — the one modelled on `_shell_score` — called
a thin-walled part a surface. `meshfix` still does. The rule "closed ⇒ 0, else
thinness" (§3.2) cannot separate a 1.2 mm moulded skin from a zero-thickness
sheet, because a thin-walled part *is* thin by every measure the quotient sees;
what separates them is that one bounds a volume and the other bounds nothing.

The model in §9 is exactly this case, and A10 refuses it as a shell. That
refusal is not wrong in its own terms — the mesh really is open, with 67
boundary edges — but the reason offered ("this is a surface, supply a wall") is
the wrong diagnosis: the part has a wall of `|V|/A = 0.0012`, and the 67 open
edges are a defect. Stepper now repairs first and measures the implied wall
before deciding; on that path the same file closes to a manifold and needs no
thickness at all.

Porting the fix here is not a one-line change, because `diagnose` must not
mutate its input (SPEC 12) — so it cannot repair first the way Stepper does.
The honest options are to report the implied wall alongside `shell_score` and
let A10's message name it, or to run the check against a repaired copy and say
so in the report. Recorded rather than silently fixed, because a criterion that
refuses for a reason that is not the real one is worse than one that fails.
