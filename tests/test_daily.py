from datetime import date, timedelta

import pytest
from sqlalchemy import update

from wordladder import daily, engine, rules
from wordladder.db import GamePlayer, SessionLocal, utcnow

DAY = date(2026, 11, 23)  # a Monday


@pytest.fixture(autouse=True)
def fixed_day(monkeypatch):
    holder = {"day": DAY}
    monkeypatch.setattr(daily, "today", lambda: holder["day"])
    return holder


def solve(client, extra=0, delay_s=0):
    """Open today's ladder, start it and solve it in par + `extra` steps."""
    g = client.post("/api/daily").json()
    code = g["code"]
    client.post(f"/api/games/{code}/start")
    if delay_s:
        with SessionLocal() as db:
            db.execute(update(GamePlayer).where(GamePlayer.game.has(code=code)).values(
                started_at=utcnow() - timedelta(seconds=delay_s)))
            db.commit()
    g = client.get(f"/api/games/{code}").json()
    graph = engine.graph(g["length"])
    for _ in range(extra):  # wander off one step and come back with undo
        detour = next(n for n in graph.neighbours[g["current"]] if n not in (g["start"], g["end"]))
        client.post(f"/api/games/{code}/moves", json={"word": detour})
        client.post(f"/api/games/{code}/undo")
    for w in graph.shortest_path(g["current"], g["end"])[1:]:
        g = client.post(f"/api/games/{code}/moves", json={"word": w}).json()
    assert g["status"] == "finished", g
    return g


def test_same_puzzle_for_everyone_and_changes_daily():
    p1, p2 = daily.puzzle(DAY), daily.puzzle(DAY)
    assert p1 == p2
    assert daily.puzzle(DAY + timedelta(days=1)) != p1
    n = daily.length_for(DAY)
    assert len(p1.start) == len(p1.end) == n
    lo, hi = engine.PAR_RANGES[n][daily.difficulty_for(DAY)]
    assert lo <= p1.par <= hi
    # The length varies from day to day, but the daily is never 6 letters.
    assert {daily.length_for(DAY + timedelta(days=i)) for i in range(30)} == {4, 5}


def test_one_attempt_and_words_hidden_until_start(client_factory):
    a = client_factory("Aayushi")
    g = a.post("/api/daily").json()
    assert g["mode"] == "daily" and g["start"] is None and g["end"] is None
    assert g["length"] == daily.length_for(DAY)
    assert a.post("/api/daily").json()["code"] == g["code"]  # same attempt, not a new one
    assert a.post(f"/api/games/{g['code']}/moves", json={"word": "abcd"}).status_code == 400

    started = a.post(f"/api/games/{g['code']}/start").json()
    p = daily.puzzle(DAY)
    assert (started["start"], started["end"], started["par"]) == (p.start, p.end, p.par)
    hint = a.post(f"/api/games/{g['code']}/hint").json()  # allowed, but costs a step
    assert hint["penalty"] == 1 and hint["game"]["steps_used"] == 1
    assert hint["game"]["hints_left"] == rules.HINTS[len(p.start)] - 1
    assert a.post(f"/api/games/{g['code']}/again", json={}).status_code == 400
    # Dailies aren't listed with regular games.
    assert all(x["code"] != g["code"] for x in a.get("/api/games").json()["active"])


def test_today_board_ranks_steps_then_time(client_factory):
    fast_long = client_factory("Kabir")
    slow_short = client_factory("Riya")
    quitter = client_factory("Dev")
    me = client_factory("Aayushi")
    solve(fast_long, extra=1, delay_s=10)
    solve(slow_short, delay_s=90)
    solve(me, delay_s=30)
    code = quitter.post("/api/daily").json()["code"]
    quitter.post(f"/api/games/{code}/start")
    quitter.post(f"/api/games/{code}/give-up")

    board = me.get("/api/leaderboard/today").json()
    names = [r["name"] for r in board["rows"]]
    assert names.index("Aayushi") < names.index("Riya") < names.index("Kabir") < names.index("Dev")
    assert board["me"]["name"] == "Aayushi" and board["me"]["stars"] == 3
    dev = next(r for r in board["rows"] if r["name"] == "Dev")
    assert dev["gave_up"] and dev["rank"] is None

    card = me.get("/api/daily").json()
    assert card["mine"]["rank"] == board["me"]["rank"] and card["played"] >= 4


def test_week_board_and_streak(client_factory, fixed_day):
    a = client_factory("WeekA")
    b = client_factory("WeekB")
    fixed_day["day"] = DAY + timedelta(days=100)  # a fresh week: Monday 3 Mar 2027
    monday = fixed_day["day"] - timedelta(days=fixed_day["day"].weekday())
    for offset in range(3):
        fixed_day["day"] = monday + timedelta(days=offset)
        solve(a)
        if offset == 2:
            solve(b, extra=1)
    assert a.get("/api/daily").json()["streak"] == 3

    week = a.get("/api/leaderboard/week").json()
    top = [r for r in week["rows"] if r["name"] in ("WeekA", "WeekB")]
    assert top[0]["name"] == "WeekA" and top[0]["stars"] == 9 and top[0]["days"] == 3
    assert top[1]["stars"] == 2

    fixed_day["day"] = monday + timedelta(days=4)  # skipped a day
    assert a.get("/api/daily").json()["streak"] == 0


def test_friends_board(client_factory):
    a, b = client_factory("Aayushi"), client_factory("Riya")
    path = engine.graph(4).shortest_path("cold", "warm")
    code = a.post("/api/games", json={"mode": "race", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    b.post(f"/api/games/{code}/join")
    for c in (a, b):
        c.post(f"/api/games/{code}/start")
    for w in path[1:]:
        a.post(f"/api/games/{code}/moves", json={"word": w})
    b.post(f"/api/games/{code}/give-up")

    code = a.post("/api/games", json={"mode": "team", "length": 4, "start": "cold", "end": "warm"}).json()["code"]
    b.post(f"/api/games/{code}/join")
    for i, w in enumerate(path[1:]):
        (a if i % 2 == 0 else b).post(f"/api/games/{code}/moves", json={"word": w})

    rows = a.get("/api/leaderboard/friends").json()["rows"]
    assert rows == [{"name": "Riya", "won": 1, "lost": 0, "tied": 0, "team_games": 1, "avg_stars": 3.0}]
    assert b.get("/api/leaderboard/friends").json()["rows"][0]["lost"] == 1


def test_harder_from_switch_date_and_past_days_unchanged():
    before = daily.HARDER_FROM - timedelta(days=1)
    assert daily.difficulty_for(before) == "easy" and daily.difficulty_for(daily.HARDER_FROM) == "medium"
    for day in (daily.HARDER_FROM, daily.HARDER_FROM + timedelta(days=1)):
        lo, hi = engine.PAR_RANGES[daily.length_for(day)]["medium"]
        assert lo <= daily.puzzle(day).par <= hi
    assert daily.puzzle(before).par <= engine.PAR_RANGES[daily.length_for(before)]["easy"][1]
