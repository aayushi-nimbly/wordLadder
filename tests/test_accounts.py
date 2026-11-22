import base64
import json
import time
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from wordladder import google
from wordladder.main import _safe_next, app

from .conftest import sign_in


def fresh() -> TestClient:
    c = TestClient(app)
    c.__enter__()
    return c


def id_token(**claims) -> str:
    body = {"aud": google.CLIENT_ID, "iss": "https://accounts.google.com", "exp": time.time() + 600, **claims}
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()  # noqa: E731
    return f"{enc({'alg': 'RS256'})}.{enc(body)}.signature"


@pytest.fixture
def fake_google(monkeypatch):
    """Google's token endpoint, answering with this person."""
    who = {"sub": "g-123", "email": "aayushi@example.com", "given_name": "Aayushi", "name": "Aayushi Rai"}
    monkeypatch.setattr(google, "finish", lambda code, verifier, redirect: google.read_id_token(id_token(**who)))
    return who


def google_round_trip(client: TestClient, next_path: str = "/") -> str:
    r = client.get("/auth/google/login", params={"next": next_path}, follow_redirects=False)
    assert r.status_code == 302
    url = urlparse(r.headers["location"])
    q = parse_qs(url.query)
    assert url.netloc == "accounts.google.com" and q["client_id"] == [google.CLIENT_ID]
    assert q["scope"] == ["openid email profile"] and q["code_challenge_method"] == ["S256"]
    assert q["redirect_uri"] == ["http://testserver/auth/google/callback"]
    r = client.get("/auth/google/callback", params={"code": "abc", "state": q["state"][0]}, follow_redirects=False)
    assert r.status_code == 302
    return r.headers["location"]


def test_needs_sign_in_then_username():
    c = fresh()
    assert c.get("/api/me").status_code == 401
    assert c.get("/api/games").status_code == 401
    sign_in(c, "someone")
    me = c.get("/api/me").json()
    assert me["needs_username"] and me["name"] is None
    assert c.get("/api/games").status_code == 403  # pick a username before playing


def test_google_sign_in_and_username(fake_google):
    c = fresh()
    assert google_round_trip(c, "/j/ABCDE") == "/j/ABCDE"  # back to the invite after signing in
    me = c.get("/api/me").json()
    assert me["needs_username"] and me["suggestion"] == "Aayushi" and me["email"] == "aayushi@example.com"

    assert c.post("/api/username", json={"username": "a b"}).status_code == 400
    r = c.post("/api/username", json={"username": "Aayushi"})
    assert r.json()["name"] == "Aayushi" and not r.json()["needs_username"]
    assert c.post("/api/username", json={"username": "Other"}).status_code == 400  # only once

    # Someone else whose Google first name is also Aayushi gets a free variant suggested,
    # and can't take the same name in any case.
    other = sign_in(fresh(), "another-google-account")
    other.cookies.set("wl_name_hint", "Aayushi")
    assert other.get("/api/me").json()["suggestion"] == "Aayushi2"
    r = other.post("/api/username", json={"username": "aayushi"})
    assert r.status_code == 400 and "taken" in r.json()["detail"]


def test_same_google_account_on_another_device(fake_google):
    phone = fresh()
    google_round_trip(phone)
    phone.post("/api/username", json={"username": "Aayushi"})
    code = phone.post("/api/games", json={"mode": "solo", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    phone.post(f"/api/games/{code}/moves", json={"word": "cord"})

    laptop = fresh()  # another browser, or incognito
    google_round_trip(laptop)
    assert laptop.get("/api/me").json()["name"] == "Aayushi"
    assert laptop.get(f"/api/games/{code}").json()["current"] == "cord"

    laptop.post("/api/logout")
    assert laptop.get("/api/me").status_code == 401
    assert phone.get("/api/me").status_code == 200  # other devices stay signed in


def test_callback_rejects_bad_state_and_cancel(fake_google):
    c = fresh()
    c.get("/auth/google/login", follow_redirects=False)
    r = c.get("/auth/google/callback", params={"code": "abc", "state": "forged"}, follow_redirects=False)
    assert r.headers["location"] == "/?signin=expired" and c.get("/api/me").status_code == 401
    r = c.get("/auth/google/callback", params={"error": "access_denied"}, follow_redirects=False)
    assert r.headers["location"] == "/?signin=cancelled"


def test_id_token_checks():
    assert google.read_id_token(id_token(sub="x"))["sub"] == "x"
    with pytest.raises(google.GoogleError):
        google.read_id_token(id_token(sub="x", aud="someone-elses-app"))
    with pytest.raises(google.GoogleError):
        google.read_id_token(id_token(sub="x", iss="https://evil.example"))
    with pytest.raises(google.GoogleError):
        google.read_id_token(id_token(sub="x", exp=time.time() - 5))
    with pytest.raises(google.GoogleError):
        google.read_id_token("not-a-token")


def test_only_local_redirects():
    assert _safe_next("/g/ABCDE") == "/g/ABCDE"
    assert _safe_next("//evil.example") == "/" and _safe_next("https://evil.example") == "/" and _safe_next(None) == "/"


def test_delete_account_keeps_friends_games(client_factory):
    a, b = client_factory("Aayushi"), client_factory("Riya")
    code = a.post("/api/games", json={"mode": "team", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    b.post(f"/api/games/{code}/join")
    assert a.post("/api/account/delete").status_code == 200
    assert a.get("/api/me").status_code == 401
    g = b.get(f"/api/games/{code}").json()
    assert [p["name"] for p in g["players"]] == ["deleted", "Riya"]
    # The username is free again, and signing in with that Google account starts a new account.
    sign_in(a, "aayushi")
    assert a.get("/api/me").json()["needs_username"]
    assert a.post("/api/username", json={"username": "Aayushi"}).status_code == 200


def test_privacy_and_terms_pages():
    c = fresh()
    assert "aayushirai9900@gmail.com" in c.get("/privacy").text
    assert c.get("/terms").status_code == 200


def test_old_guest_data_is_wiped_once(tmp_path):
    from sqlalchemy import create_engine, inspect, text

    from wordladder.db import init_db

    eng = create_engine(f"sqlite:///{tmp_path}/old.db")
    with eng.begin() as conn:  # the guest-era schema, with some data
        conn.execute(text("CREATE TABLE players (id INTEGER PRIMARY KEY, name VARCHAR(24), token_hash VARCHAR(64))"))
        conn.execute(text("INSERT INTO players (name, token_hash) VALUES ('Old guest', 'abc')"))
        conn.execute(text("CREATE TABLE games (id INTEGER PRIMARY KEY, code VARCHAR(8))"))
        conn.execute(text("INSERT INTO games (code) VALUES ('OLD11')"))

    init_db(eng)
    cols = {c["name"] for c in inspect(eng).get_columns("players")}
    assert {"google_sub", "name_key"} <= cols and "token_hash" not in cols
    with eng.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM players")).scalar() == 0
        assert conn.execute(text("SELECT count(*) FROM games")).scalar() == 0
        conn.execute(text("INSERT INTO players (google_sub, name, name_key, created_at) "
                          "VALUES ('g1', 'New', 'new', '2026-11-23')"))

    init_db(eng)  # a second start must not wipe again
    with eng.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM players")).scalar() == 1
