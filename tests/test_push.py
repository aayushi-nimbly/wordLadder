import base64
import json
from datetime import timedelta

import pytest
from pywebpush import WebPushException
from sqlalchemy import select, update

from wordladder import engine, push
from wordladder.db import Game, PushSubscription, SessionLocal, utcnow


class FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code


@pytest.fixture
def sent(monkeypatch):
    """Capture pushes instead of sending them. Endpoints containing 'gone' answer 410."""
    out = []

    def fake_webpush(sub, data, **kwargs):
        if "gone" in sub["endpoint"]:
            raise WebPushException("gone", response=FakeResponse(410))
        out.append({"endpoint": sub["endpoint"], **json.loads(data)})

    monkeypatch.setattr(push, "webpush", fake_webpush)
    return out


def subscribe(client, endpoint):
    r = client.post("/api/push/subscribe", json={"endpoint": endpoint, "keys": {"p256dh": "k" * 87, "auth": "a" * 22}})
    assert r.status_code == 200, r.text


def test_public_key_is_a_p256_point(client_factory):
    c = client_factory("A")
    key = c.get("/api/push/key").json()["key"]
    raw = base64.urlsafe_b64decode(key + "=" * (-len(key) % 4))
    assert len(raw) == 65 and raw[0] == 4


def test_subscribe_rejects_non_https(client_factory):
    c = client_factory("A")
    r = c.post("/api/push/subscribe", json={"endpoint": "http://evil.example/x", "keys": {"p256dh": "k", "auth": "a"}})
    assert r.status_code == 400


def test_turn_notifications_follow_the_game(client_factory, sent):
    a = client_factory("Aayushi")
    b = client_factory("Riya")
    subscribe(a, "https://push.example/aayushi-phone")
    subscribe(b, "https://push.example/riya-phone")
    code = a.post("/api/games", json={"mode": "team", "length": 4, "start": "cold", "end": "warm"}).json()["code"]

    b.post(f"/api/games/{code}/join")
    assert [(n["endpoint"], n["title"]) for n in sent] == [("https://push.example/aayushi-phone", "Riya joined")]
    sent.clear()

    path = engine.graph(4).shortest_path("cold", "warm")
    a.post(f"/api/games/{code}/moves", json={"word": path[1]})
    assert len(sent) == 1 and sent[0]["endpoint"].endswith("riya-phone")
    assert sent[0]["title"] == "Your turn" and path[1].upper() in sent[0]["body"]
    assert sent[0]["url"] == f"/g/{code}"
    sent.clear()

    # Aayushi has the game open: Riya's move reaches her live, not as a notification.
    with a.websocket_connect(f"/ws/games/{code}") as ws:
        ws.receive_json()
        b.post(f"/api/games/{code}/moves", json={"word": path[2]})
        ws.receive_json()
    assert sent == []

    a.post(f"/api/games/{code}/moves", json={"word": path[3]})
    sent.clear()
    b.post(f"/api/games/{code}/moves", json={"word": path[4]})
    assert len(sent) == 1 and sent[0]["title"].startswith("You did it together")
    sent.clear()

    new_code = b.post(f"/api/games/{code}/again", json={}).json()["code"]
    assert sent[0]["title"] == "Riya started a new ladder" and sent[0]["url"] == f"/g/{new_code}"


def test_solo_games_never_notify(client_factory, sent):
    a = client_factory("Solo")
    subscribe(a, "https://push.example/solo")
    code = a.post("/api/games", json={"mode": "solo", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    a.post(f"/api/games/{code}/moves", json={"word": "cord"})
    assert sent == []


def test_dead_subscriptions_are_removed(client_factory, sent):
    a = client_factory("A")
    subscribe(a, "https://push.example/gone-1")
    subscribe(a, "https://push.example/alive-1")
    r = a.post("/api/push/test").json()
    assert r["sent"] == 1
    with SessionLocal() as db:
        endpoints = set(db.scalars(select(PushSubscription.endpoint)))
    assert "https://push.example/gone-1" not in endpoints and "https://push.example/alive-1" in endpoints


def test_one_reminder_per_waiting_turn(client_factory, sent):
    a = client_factory("Aayushi")
    b = client_factory("Riya")
    subscribe(b, "https://push.example/riya-reminder")
    code = a.post("/api/games", json={"mode": "team", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    b.post(f"/api/games/{code}/join")
    a.post(f"/api/games/{code}/moves", json={"word": "cord"})
    sent.clear()

    def due():
        return [n for n in push.due_reminders() if n.url == f"/g/{code}"]

    assert due() == []  # not waited long enough
    with SessionLocal() as db:
        db.execute(update(Game).where(Game.code == code).values(updated_at=utcnow() - timedelta(hours=25)))
        db.commit()
    notes = due()
    assert len(notes) == 1 and notes[0].title == "Aayushi is waiting for your word"
    push.send_now(notes)
    assert sent[0]["endpoint"].endswith("riya-reminder")
    assert due() == []  # only once per turn
