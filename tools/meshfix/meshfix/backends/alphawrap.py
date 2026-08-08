"""CGAL 3D Alpha Wrapping backend (SPEC 7.1, milestone M4).

The first backend in the chain, because it is the only one that produces a
solid whose *shape* follows the input rather than a quantisation of it. On the
open-shell model in NOTES.md §9 it returns 5 356 faces — watertight, 2-manifold,
one component, no self-intersections — where the voxel backend needs 71 920 for
the same body.

The work happens in a separate ``aw3`` binary (``cpp/aw3.cpp``), built by
``scripts/build_aw3.sh``. That keeps CGAL out of meshfix's install: when the
binary is absent the backend reports itself unavailable, the chain falls through
to ``voxel``, and the report records the fact rather than quietly returning
lower-quality geometry (change C14).
"""

from __future__ import annotations

import shutil
import subprocess
import time
from logging import Logger
from pathlib import Path

import trimesh

from . import BackendResult, RunContext

BINARY_NAME = "aw3"
#: A wrap that has not finished by now is not going to; alpha is too small for
#: the model and the caller needs to hear that rather than wait.
RUN_TIMEOUT_S = 600
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
        """Alpha is the smallest feature the wrap may enter; offset how far it stands off.

        Both scale with the model, never with its triangle count: alpha is a
        length in model units, so a fixed value would carve a phone case and
        skate over a bridge. ``diagonal/60`` follows CGAL's own examples.

        Note what this does *not* do — infer a wall thickness. On an open shell
        the wrap closes around the surface and the wall it produces is about
        twice ``offset``, which is a regularisation parameter, not a number the
        user chose. Shells are thickened before any backend runs, precisely so
        the wall is theirs (SPEC 5.3).
        """
        diagonal = ctx.bbox_diagonal or 1.0
        alpha = ctx.alpha if ctx.alpha is not None else diagonal / 60.0
        offset = ctx.offset if ctx.offset is not None else alpha / 30.0
        return {"alpha": float(alpha), "offset": float(offset)}

    def run(
        self, input_path: Path, output_path: Path, params: dict, log: Logger
    ) -> BackendResult:
        started = time.perf_counter()
        binary = find_binary()
        if binary is None:
            return BackendResult(success=False, message=BUILD_HINT)

        command = [
            str(binary), str(input_path), str(output_path),
            "--alpha", repr(float(params["alpha"])),
            "--offset", repr(float(params["offset"])),
        ]
        log.debug("alphawrap: %s", " ".join(command))
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True, timeout=RUN_TIMEOUT_S, check=False
            )
        except subprocess.TimeoutExpired:
            return BackendResult(
                success=False,
                wall_time_s=time.perf_counter() - started,
                params_used=params,
                message=f"aw3 did not finish within {RUN_TIMEOUT_S}s; try a larger --alpha",
            )

        tail = completed.stderr.strip().splitlines()[-4:]
        for line in tail:
            log.info("alphawrap: %s", line)

        # A backend never decides whether it succeeded — validation does (SPEC
        # 15). "Success" here means only that a file exists to validate.
        wrote = completed.returncode == 0 and output_path.is_file()
        return BackendResult(
            success=wrote,
            output_path=output_path if wrote else None,
            wall_time_s=time.perf_counter() - started,
            params_used=params,
            stdout_tail="\n".join(tail),
            message="" if wrote else (tail[-1] if tail else f"aw3 exited {completed.returncode}"),
        )
