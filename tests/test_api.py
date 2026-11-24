from wordladder import engine, rules


def test_requires_name(client_factory):
    from fastapi.testclient import TestClient

    from wordladder.main import app

    with TestClient(app) as anon:
        assert anon.get("/api/me").status_code == 401
        assert anon.post("/api/players", json={"name": "x"}).status_code in (404, 405)  # guests are gone
        assert anon.post("/api/games", json={"mode": "solo", "length": 4, "difficulty": "easy"}).status_code == 401


def test_suggest_and_check(client_factory):
    c = client_factory("Aayushi")
    s = c.get("/api/suggest", params={"length": 6, "difficulty": "easy"}).json()
    assert len(s["start"]) == 6 and 4 <= s["par"] <= 5
    assert c.post("/api/puzzles/check", json={"length": 4, "start": "cold", "end": "warm"}).json() == {"par": 4}
    r = c.post("/api/puzzles/check", json={"length": 4, "start": "cold", "end": "qzxv"})
    assert r.status_code == 400 and "dictionary" in r.json()["detail"]


def test_solo_game_to_three_stars(client_factory):
    c = client_factory("Aayushi")
    g = c.post("/api/games", json={"mode": "solo", "length": 4, "start": "cold", "end": "warm"}).json()
    assert g["status"] == "active" and g["my_turn"] and g["par"] == 4
    code = g["code"]

    bad = c.post(f"/api/games/{code}/moves", json={"word": "warm"})
    assert bad.status_code == 400 and "only one letter" in bad.json()["detail"]
    bad = c.post(f"/api/games/{code}/moves", json={"word": "colq"})
    assert "dictionary" in bad.json()["detail"]

    for w in engine.graph(4).shortest_path("cold", "warm")[1:]:
        g = c.post(f"/api/games/{code}/moves", json={"word": w}).json()
    assert g["status"] == "won" and g["stars"] == 3 and g["steps_used"] == 4
    assert g["solution"][0] == "cold"


def test_team_game_alternates_turns_and_streams_live(client_factory):
    a = client_factory("Aayushi")
    b = client_factory("Riya")
    g = a.post("/api/games", json={"mode": "team", "length": 4, "start": "cold", "end": "warm"}).json()
    code = g["code"]
    assert g["status"] == "waiting"
    assert a.post(f"/api/games/{code}/moves", json={"word": "cord"}).json()["detail"].startswith("Waiting")

    joined = b.post(f"/api/games/{code}/join").json()
    assert joined["status"] == "active" and joined["my_seat"] == 2 and not joined["my_turn"]

    path = engine.graph(4).shortest_path("cold", "warm")
    with b.websocket_connect(f"/ws/games/{code}") as ws:
        first = ws.receive_json()
        assert first["type"] == "state"
        assert any(p["online"] and p["me"] for p in first["game"]["players"])

        # Riya can't move on Aayushi's turn
        r = b.post(f"/api/games/{code}/moves", json={"word": path[1]})
        assert r.status_code == 400 and "friend's turn" in r.json()["detail"]

        a.post(f"/api/games/{code}/moves", json={"word": path[1]})
        live = ws.receive_json()["game"]
        assert live["my_turn"] and live["ladder"][-1] == {"word": path[1], "seat": 1, "distance": 3}

    # Riya takes a detour, then undoes it
    detour = next(n for n in engine.graph(4).neighbours[path[1]] if engine.graph(4).distance(n, "warm") >= 3 and n != "cold")
    b.post(f"/api/games/{code}/moves", json={"word": detour})
    a.post(f"/api/games/{code}/undo")
    g = a.get(f"/api/games/{code}").json()
    assert g["current"] == path[1] and g["steps_used"] == 2 and g["my_turn"]

    hint = a.post(f"/api/games/{code}/hint").json()
    pos = engine.changed_position(path[1], path[2])
    assert (hint["position"], hint["letter"], hint["word"]) == (pos, path[2][pos], path[2])
    assert hint["game"]["hints_left"] == rules.HINTS[4] - 1 and hint["penalty"] == 0
    assert hint["game"]["steps_used"] == 2  # free in team games

    seat_turn = {1: a, 2: b}
    for w in path[2:]:
        g = seat_turn[g["turn_seat"]].post(f"/api/games/{code}/moves", json={"word": w}).json()
    assert g["status"] == "won"
    assert g["stars"] == rules.stars_for(g["steps_used"], 4) == 2

    again = b.post(f"/api/games/{code}/again", json={}).json()
    assert again["status"] == "active" and [p["name"] for p in again["players"]] == ["Riya", "Aayushi"]
    listing = a.get("/api/games").json()
    assert listing["active"][0]["code"] == again["code"] and listing["active"][0]["partner"] == "Riya"


def test_outsider_cannot_see_or_join_full_game(client_factory):
    a = client_factory("Ann")
    b = client_factory("Ben")
    c = client_factory("Cat")
    code = a.post("/api/games", json={"mode": "team", "length": 5, "difficulty": "easy"}).json()["code"]
    b.post(f"/api/games/{code}/join")
    assert c.get(f"/api/games/{code}").status_code == 403
    assert c.post(f"/api/games/{code}/join").status_code == 400


def test_stars():
    assert [rules.stars_for(s, 5) for s in (5, 6, 7, 8)] == [3, 2, 2, 1]


def test_ping_needs_no_sign_in():
    from fastapi.testclient import TestClient

    from wordladder.main import app

    with TestClient(app) as c:
        assert c.get("/ping").json() == {"ok": True}
