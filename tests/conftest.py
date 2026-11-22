import os
import tempfile

import pytest

# Point the app at a throwaway database before it is imported, and turn on the test-only sign-in
# that stands in for Google.
_tmp = tempfile.mkdtemp()
os.environ["WORDLADDER_DB"] = os.environ.get("TEST_DB") or f"sqlite:///{_tmp}/test.db"
os.environ["WORDLADDER_VAPID_FILE"] = f"{_tmp}/vapid.pem"
os.environ["WORDLADDER_DEV_LOGIN"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from wordladder.db import Base, SessionLocal  # noqa: E402
from wordladder.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def empty_db():
    """Each test starts with no players or games, so usernames can repeat across tests."""
    with TestClient(app):  # runs startup, which creates the tables
        pass
    with SessionLocal() as db:
        for table in reversed(Base.metadata.sorted_tables):
            if table.name != "meta":
                db.execute(table.delete())
        db.commit()


def sign_in(client: TestClient, google_id: str, username: str | None = None) -> TestClient:
    """Sign in as a Google account (via the test stand-in) and pick a username if given."""
    r = client.get("/auth/dev-login", params={"sub": google_id}, follow_redirects=False)
    assert r.status_code == 302, r.text
    if username:
        r = client.post("/api/username", json={"username": username})
        assert r.status_code == 200, r.text
    return client


@pytest.fixture
def client_factory():
    clients = []

    def make(name: str) -> TestClient:
        c = TestClient(app)
        c.__enter__()
        clients.append(c)
        return sign_in(c, name.lower(), name)

    yield make
    for c in clients:
        c.__exit__(None, None, None)
