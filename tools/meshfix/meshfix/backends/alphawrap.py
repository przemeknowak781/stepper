"""CGAL 3D Alpha Wrapping backend (SPEC 7.1, milestone M4).

Not yet implemented. The class exists so ``--backend auto`` can list it,
discover it is unavailable, and record that fact in the report's warnings
rather than silently producing a lower-quality result (change C14).
"""

from __future__ import annotations

import shutil
from logging import Logger
from pathlib import Path

import trimesh

from . import BackendResult, RunContext

BINARY_NAME = "aw3"
BUILD_HINT = (
    "alpha wrapping needs the `aw3` helper binary; build it with "
    "scripts/build_aw3.sh (requires CGAL 5.5+, Boost, Eigen, CMake 3.12+)"
)


def find_binary() -> Path | None:
    local = Path(__file__).resolve().parent.parent / "bin" / BINARY_NAME
    if local.is_file():
        return local
    found = shutil.which(BINARY_NAME)
    return Path(found) if found else None


class AlphaWrapBackend:
    name = "alphawrap"

    def available(self) -> tuple[bool, str]:
        return (True, "") if find_binary() else (False, BUILD_HINT)

    def suggest_params(self, mesh: trimesh.Trimesh, ctx: RunContext) -> dict:
        diagonal = ctx.bbox_diagonal or 1.0
        alpha = ctx.alpha if ctx.alpha is not None else diagonal / 60.0
        offset = ctx.offset if ctx.offset is not None else alpha / 30.0
        return {"alpha": float(alpha), "offset": float(offset)}

    def run(
        self, input_path: Path, output_path: Path, params: dict, log: Logger
    ) -> BackendResult:
        raise NotImplementedError("alphawrap backend lands in milestone M4")
