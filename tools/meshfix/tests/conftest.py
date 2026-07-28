from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def project_root() -> Path:
    """Repo root, so CLI subprocesses can import the package."""
    return Path(__file__).resolve().parent.parent
