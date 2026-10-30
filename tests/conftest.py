"""Shared test setup."""
import shutil

import pytest

from dryrun import storage


@pytest.fixture(autouse=True)
def _fresh_auth_lockouts():
    """authguard state lives in storage and every TestClient has the same IP: start each test unlocked."""
    shutil.rmtree(storage.LOCAL_DATA / "_private" / "auth", ignore_errors=True)
    yield
    shutil.rmtree(storage.LOCAL_DATA / "_private" / "auth", ignore_errors=True)
