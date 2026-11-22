from datetime import timedelta

from sqlalchemy import update

from wordladder import engine
from wordladder.db import GamePlayer, SessionLocal, utcnow

from .test_push import sent, subscribe  # noqa: F401  (fixture)

PATH = engine.graph(4).shortest_path("cold", "warm")


def play(client, code, words):
    for w in words:
        r = client.post(f"/api/games/{code}/moves", json={"word": w})
        assert r.status_code == 200, r.text
    return r.json()


def new_race(a, b):
    code = a.post("/api/games", json={"mode": "race", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    assert b.post(f"/api/games/{code}/join").json()["status"] == "active"
    return code


def test_race_needs_start_and_keeps_ladders_separate(client_factory):
    a, b = client_factory("Aayushi"), client_factory("Riya")
    code = new_race(a, b)

    r = a.post(f"/api/games/{code}/moves", json={"word": PATH[1]})
    assert r.status_code == 400 and "Start" in r.json()["detail"]
    assert not a.get(f"/api/games/{code}").json()["my_turn"]

    a.post(f"/api/games/{code}/start")
    b.post(f"/api/games/{code}/start")
    # Both can move at the same time; each has their own ladder.
    play(a, code, [PATH[1]])
    gb = play(b, code, [PATH[1], PATH[2]])
    assert [m["word"] for m in gb["ladder"]] == PATH[1:3] and gb["steps_used"] == 2
    ga = a.get(f"/api/games/{code}").json()
    assert [m["word"] for m in ga["ladder"]] == PATH[1:2] and ga["current"] == PATH[1]
    # The opponent's words stay hidden until the race is over.
    them = next(s for s in ga["race"]["seats"] if s["seat"] == 2)
    assert them["steps"] == 2 and them["ladder"] is None
    assert a.post(f"/api/games/{code}/hint").status_code == 400


def test_fewest_steps_wins_even_if_slower(client_factory):
    a, b = client_factory("Aayushi"), client_factory("Riya")
    code = new_race(a, b)
    a.post(f"/api/games/{code}/start")
    b.post(f"/api/games/{code}/start")

    detour = next(n for n in engine.graph(4).neighbours["cold"] if n != PATH[1])
    play(a, code, [detour])
    a.post(f"/api/games/{code}/undo")  # wasted move still counts
    ga = play(a, code, PATH[1:])
    assert ga["status"] == "active" and ga["my_turn"] is False  # finished, waiting for Riya

    gb = play(b, code, PATH[1:])
    assert gb["status"] == "finished"
    assert gb["race"]["winner_seat"] == 2 and gb["race"]["outcome"] == "won"
    assert a.get(f"/api/games/{code}").json()["race"]["outcome"] == "lost"
    seats = {s["seat"]: s for s in gb["race"]["seats"]}
    assert seats[1]["steps"] == 5 and seats[2]["steps"] == 4
    assert seats[1]["ladder"] == PATH[1:]  # revealed once it's over

    listing = a.get("/api/games").json()
    assert listing["finished"][0]["outcome"] == "lost"


def test_same_steps_faster_time_wins(client_factory):
    a, b = client_factory("Aayushi"), client_factory("Riya")
    code = new_race(a, b)
    a.post(f"/api/games/{code}/start")
    b.post(f"/api/games/{code}/start")
    with SessionLocal() as db:  # Aayushi started 10 minutes earlier, so her time is longer
        db.execute(update(GamePlayer).where(GamePlayer.seat == 1, GamePlayer.game.has(code=code)).values(
            started_at=utcnow() - timedelta(minutes=10)))
        db.commit()
    play(a, code, PATH[1:])
    g = play(b, code, PATH[1:])
    assert g["race"]["winner_seat"] == 2


def test_giving_up_hands_the_win(client_factory):
    a, b = client_factory("Aayushi"), client_factory("Riya")
    code = new_race(a, b)
    a.post(f"/api/games/{code}/start")
    b.post(f"/api/games/{code}/start")
    a.post(f"/api/games/{code}/give-up")
    assert a.get(f"/api/games/{code}").json()["status"] == "active"
    g = play(b, code, PATH[1:])
    assert g["status"] == "finished" and g["race"]["outcome"] == "won"


def test_race_notifications(client_factory, sent):  # noqa: F811
    a, b = client_factory("Aayushi"), client_factory("Riya")
    subscribe(a, "https://push.example/race-a")
    subscribe(b, "https://push.example/race-b")
    code = a.post("/api/games", json={"mode": "race", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    b.post(f"/api/games/{code}/join")
    assert [n["title"] for n in sent] == ["Riya accepted your race"]
    sent.clear()

    a.post(f"/api/games/{code}/start")
    b.post(f"/api/games/{code}/start")
    play(a, code, PATH[1:2])
    assert sent == []  # no "your turn" in a race
    play(b, code, PATH[1:])
    assert [(n["endpoint"], n["title"]) for n in sent] == [("https://push.example/race-a", "Riya finished in 4 steps")]
    sent.clear()
    play(a, code, PATH[2:])
    assert [(n["endpoint"], n["title"]) for n in sent] == [("https://push.example/race-b", "You won the race 🏆")]


def test_hidden_tab_still_gets_notified(client_factory, sent):  # noqa: F811
    a, b = client_factory("Aayushi"), client_factory("Riya")
    subscribe(b, "https://push.example/hidden-b")
    code = a.post("/api/games", json={"mode": "team", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    b.post(f"/api/games/{code}/join")
    with b.websocket_connect(f"/ws/games/{code}") as ws:
        ws.receive_json()
        ws.send_text("hidden")  # Riya switched apps / locked her phone
        me = next(p for p in ws.receive_json()["game"]["players"] if p["me"])
        assert not me["online"]
        a.post(f"/api/games/{code}/moves", json={"word": PATH[1]})
        ws.receive_json()
    assert [n["title"] for n in sent] == ["Your turn"]
