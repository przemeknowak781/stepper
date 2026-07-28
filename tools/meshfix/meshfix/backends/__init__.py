"""Backend registry and shared protocol (SPEC 4.1).

Backends never import one another; orchestration lives in :mod:`meshfix.cli`.
A backend reports whether it can run, proposes its own parameters, and does the
work — but it never decides whether it *succeeded*. Success is a property of
the produced mesh, established by :mod:`meshfix.validate` (SPEC 15).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from logging import Logger
from pathlib import Path
from typing import Protocol, runtime_checkable

import trimesh


@dataclass
class RunContext:
    """Global parameters a backend may consult, passed explicitly.

    Exists so ``suggest_params`` never reads module-level or global state,
    which would break the determinism guarantee (SPEC 12.1).
    """

    seed: int = 0
    max_deviation: float = 0.0
    bbox_diagonal: float = 1.0
    voxel_resolution: int = 256
    voxel_size: float | None = None
    seal: int = 1
    alpha: float | None = None
    offset: float | None = None


@dataclass
class BackendResult:
    success: bool
    output_path: Path | None = None
    wall_time_s: float = 0.0
    params_used: dict = field(default_factory=dict)
    stdout_tail: str = ""
    message: str = ""


@runtime_checkable
class Backend(Protocol):
    name: str

    def available(self) -> tuple[bool, str]: ...

    def suggest_params(self, mesh: trimesh.Trimesh, ctx: RunContext) -> dict: ...

    def run(
        self, input_path: Path, output_path: Path, params: dict, log: Logger
    ) -> BackendResult: ...


def get_backend(name: str) -> Backend:
    """Resolve a backend by name, importing it lazily."""
    if name == "voxel":
        from .voxel import VoxelBackend

        return VoxelBackend()
    if name == "alphawrap":
        from .alphawrap import AlphaWrapBackend

        return AlphaWrapBackend()
    raise KeyError(f"unknown backend {name!r}")


#: Names that ``--backend auto`` may consider, in preference order.
KNOWN_BACKENDS = ("alphawrap", "voxel")
