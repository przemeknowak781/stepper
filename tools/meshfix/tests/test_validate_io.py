"""Validation, IO determinism and CLI --dry-run tests (milestones M0, M1)."""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

from meshfix.diagnose import analyze
from meshfix.io import float32_ulp, load_mesh, save_mesh, sha256_file
from meshfix.validate import validate
from tests.fixtures.generate import build

pytestmark = pytest.mark.filterwarnings("ignore::RuntimeWarning")


# --------------------------------------------------------------------------
# io
# --------------------------------------------------------------------------

def test_save_is_deterministic(tmp_path):
    mesh = build("clean_cube")
    a, b = tmp_path / "a.stl", tmp_path / "b.stl"
    save_mesh(mesh, a)
    save_mesh(mesh, b)
    assert sha256_file(a) == sha256_file(b)


def test_stl_roundtrip_preserves_geometry(tmp_path):
    mesh = build("clean_cube")
    path = tmp_path / "cube.stl"
    save_mesh(mesh, path)
    reloaded = load_mesh(path)
    assert len(reloaded.faces) == len(mesh.faces)
    assert reloaded.bounds == pytest.approx(mesh.bounds)


def test_load_does_not_silently_repair(tmp_path):
    """Loading must preserve defects, or diagnosis would report a nicer mesh."""
    mesh = build("open_cube")
    path = tmp_path / "open.stl"
    save_mesh(mesh, path)
    assert not load_mesh(path).is_watertight


def test_unsupported_format_rejected(tmp_path):
    from meshfix.io import UnsupportedFormatError

    bad = tmp_path / "mesh.xyz"
    bad.write_text("nope")
    with pytest.raises(UnsupportedFormatError):
        load_mesh(bad)


def test_float32_ulp_exceeds_naive_tolerance():
    """The reason weld tolerance is clamped (SPEC 8.1, change C9)."""
    diag = 173.0
    assert float32_ulp(diag) > diag * 1e-8


# --------------------------------------------------------------------------
# validate
# --------------------------------------------------------------------------

def test_clean_cube_passes_all_hard_criteria():
    result = validate(analyze(build("clean_cube")), expected_components=1)
    assert result.hard_failures == []
    assert result.accepted


def test_component_mismatch_fails_a7():
    d = analyze(build("two_components"))
    assert not validate(d, expected_components=1).accepted
    assert validate(d, expected_components=2).accepted


def test_a9_is_inactive_without_min_wall():
    """An inactive criterion must never count as passed (SPEC 2, change C3)."""
    result = validate(analyze(build("thin_shell")), min_wall_estimate=0.2)
    a9 = result.criteria["A9"]
    assert a9.active is False
    assert a9.passed is None
    assert result.accepted  # inactive, so it cannot block


def test_a9_binds_only_under_strict():
    d = analyze(build("thin_shell"))
    lenient = validate(d, min_wall=0.8, min_wall_estimate=0.2)
    assert lenient.criteria["A9"].passed is False
    assert lenient.accepted            # soft failure alone does not reject
    assert not validate(d, min_wall=0.8, min_wall_estimate=0.2, strict=True).accepted


def test_a8_is_two_sided():
    """Gating on the permissive direction was the central bug in v1.0 (C1)."""
    d = analyze(build("clean_cube"))
    passing = validate(d, max_deviation=0.5, hausdorff_two_sided=0.31)
    failing = validate(d, max_deviation=0.5, hausdorff_two_sided=0.72)
    assert passing.criteria["A8"].passed
    assert failing.criteria["A8"].passed is False
    assert failing.accepted                      # soft by default
    assert not validate(
        d, max_deviation=0.5, hausdorff_two_sided=0.72, strict=True
    ).accepted


def test_a10_rejects_open_shell_without_thickness():
    d = analyze(build("open_shell"))
    refused = validate(d, check_shell=True)
    assert refused.criteria["A10"].passed is False
    assert not refused.accepted
    assert "shell" in refused.criteria["A10"].reason
    allowed = validate(d, check_shell=True, shell_thickness=1.0)
    assert allowed.criteria["A10"].passed


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _run_cli(*args, cwd):
    return subprocess.run(
        [sys.executable, "-m", "meshfix.cli", "fix", *map(str, args)],
        capture_output=True, text=True, cwd=cwd,
    )


def test_cli_dry_run_reports_and_exits_cleanly(tmp_path, project_root):
    src = tmp_path / "cube.stl"
    save_mesh(build("clean_cube"), src)
    report = tmp_path / "r.json"
    proc = _run_cli(src, "--dry-run", "--report", report, cwd=project_root)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().endswith("ACCEPTED")
    data = json.loads(report.read_text())
    assert data["schema_version"] == "1.1"
    assert data["dry_run"] is True
    assert data["input"]["diagnosis"]["verdict"] == "printable"


def test_cli_rejects_open_shell_with_exit_1(tmp_path, project_root):
    src = tmp_path / "shell.stl"
    save_mesh(build("open_shell"), src)
    proc = _run_cli(src, cwd=project_root)
    assert proc.returncode == 1
    assert "--shell-thickness" in proc.stderr
    assert "REJECTED" in proc.stdout


def test_cli_rejects_contradictory_backend_flags(tmp_path, project_root):
    src = tmp_path / "cube.stl"
    save_mesh(build("clean_cube"), src)
    proc = _run_cli(src, "--backend", "voxel", "--fallback-chain", "voxel,poisson", cwd=project_root)
    assert proc.returncode == 2
    assert "mutually exclusive" in proc.stderr


def test_cli_requires_units_with_min_wall(tmp_path, project_root):
    src = tmp_path / "cube.stl"
    save_mesh(build("clean_cube"), src)
    proc = _run_cli(src, "--min-wall", "0.8", cwd=project_root)
    assert proc.returncode == 2
    assert "--units" in proc.stderr


def test_cli_printable_input_is_copied_and_accepted(tmp_path, project_root):
    src = tmp_path / "cube.stl"
    save_mesh(build("clean_cube"), src)
    out = tmp_path / "fixed.stl"
    proc = _run_cli(src, "-o", out, cwd=project_root)
    assert proc.returncode == 0, proc.stderr
    assert out.is_file()
    assert proc.stdout.strip().endswith("ACCEPTED")


def test_cli_summary_is_at_most_20_lines(tmp_path, project_root):
    src = tmp_path / "blob.stl"
    save_mesh(build("ai_like_blob"), src)
    proc = _run_cli(src, "--dry-run", cwd=project_root)
    assert len(proc.stdout.strip().splitlines()) <= 20
