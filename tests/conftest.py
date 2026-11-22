import os
import tempfile

import pytest

# Point the app at a throwaway database before it is imported.
_tmp = tempfile.mkdtemp()
os.environ["WORDLADDER_DB"] = os.environ.get("TEST_DB") or f"sqlite:///{_tmp}/test.db"
os.environ["WORDLADDER_VAPID_FILE"] = f"{_tmp}/vapid.pem"

from fastapi.testclient import TestClient  # noqa: E402

from wordladder.main import app  # noqa: E402


@pytest.fixture
def client_factory():
    clients = []

    def make(name: str) -> TestClient:
        c = TestClient(app)
        c.__enter__()
        clients.append(c)
        r = c.post("/api/players", json={"name": name})
        assert r.status_code == 200, r.text
        return c

    yield make
    for c in clients:
        c.__exit__(None, None, None)
