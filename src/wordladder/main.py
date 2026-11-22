"""FastAPI app: JSON API, the live WebSocket, and the installable web app."""

from __future__ import annotations

import hashlib
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import engine, rules
from .db import Game, GamePlayer, Player, SessionLocal, get_db, init_db
from .realtime import hub

STATIC = Path(__file__).parent / "static"
COOKIE = "wl_token"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    for n in engine.LENGTHS:  # build word graphs before the first request
        engine.graph(n)
    yield


app = FastAPI(title="Word Ladder", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

DB = Annotated[Session, Depends(get_db)]


@app.exception_handler(rules.RuleError)
async def rule_error(_: Request, exc: rules.RuleError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ---------- players ----------


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _player_from_token(db: Session, token: str | None) -> Player | None:
    if not token:
        return None
    return db.scalar(select(Player).where(Player.token_hash == _hash(token)))


def current_player(request: Request, db: DB) -> Player:
    player = _player_from_token(db, request.cookies.get(COOKIE))
    if player is None:
        raise HTTPException(401, "Enter your name to play.")
    return player


Me = Annotated[Player, Depends(current_player)]


class NameIn(BaseModel):
    name: str = Field(min_length=1, max_length=24)


def _player_out(p: Player) -> dict:
    return {"id": p.id, "name": p.name}


@app.post("/api/players")
def create_player(body: NameIn, request: Request, response: Response, db: DB):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Enter a name.")
    player = _player_from_token(db, request.cookies.get(COOKIE))
    if player:  # already a guest on this device: just rename
        player.name = name
    else:
        token = secrets.token_urlsafe(32)
        player = Player(name=name, token_hash=_hash(token))
        db.add(player)
        response.set_cookie(
            COOKIE, token, max_age=COOKIE_MAX_AGE, httponly=True, samesite="lax",
            secure=request.url.scheme == "https",
        )
    db.commit()
    return _player_out(player)


@app.get("/api/me")
def me(player: Me):
    return _player_out(player)


# ---------- puzzles ----------


@app.get("/api/suggest")
def suggest(length: int = 5, difficulty: str = "medium"):
    if length not in engine.LENGTHS or difficulty not in engine.DIFFICULTIES:
        raise HTTPException(400, "Pick 4, 5 or 6 letters and easy, medium or hard.")
    p = engine.graph(length).suggest(difficulty)
    return {"start": p.start, "end": p.end, "par": p.par}


class PuzzleIn(BaseModel):
    length: int
    start: str
    end: str


@app.post("/api/puzzles/check")
def check_puzzle(body: PuzzleIn):
    if body.length not in engine.LENGTHS:
        raise HTTPException(400, "Word length must be 4, 5 or 6.")
    return {"par": rules.check_puzzle(body.length, body.start, body.end)}


# ---------- games ----------


def _load(db: Session, code: str) -> Game:
    game = db.scalar(select(Game).where(Game.code == code.upper()))
    if game is None:
        raise HTTPException(404, "No game with that code.")
    return game


def _view(game: Game, player: Player) -> dict:
    return rules.view(game, player, hub.online(game.code))


class NewGameIn(BaseModel):
    mode: str
    length: int
    difficulty: str | None = None
    start: str | None = None
    end: str | None = None


@app.post("/api/games")
def new_game(body: NewGameIn, player: Me, db: DB):
    game = rules.create_game(db, player, body.mode, body.length, body.difficulty, body.start, body.end)
    return _view(game, player)


@app.get("/api/games")
def my_games(player: Me, db: DB):
    games = db.scalars(
        select(Game).join(GamePlayer).where(GamePlayer.player_id == player.id).order_by(Game.updated_at.desc())
    ).all()
    out = []
    for g in games:
        partner = next((s.player.name for s in g.seats if s.player_id != player.id), None)
        me_seat = rules.seat_of(g, player)
        out.append({
            "code": g.code, "mode": g.mode, "status": g.status, "length": g.length,
            "start": g.start_word, "end": g.end_word, "par": g.par, "stars": g.stars,
            "steps_used": g.steps_used, "partner": partner,
            "my_turn": g.status == "active" and g.turn_seat == me_seat,
            "updated_at": g.updated_at.isoformat() + "Z",
        })
    rank = {"my_turn": 0, "waiting": 1, "their_turn": 2, "won": 3, "gave_up": 3}
    out.sort(key=lambda x: rank["my_turn" if x["my_turn"] else "their_turn" if x["status"] == "active" else x["status"]])
    active = [x for x in out if x["status"] in ("active", "waiting")]
    finished = [x for x in out if x["status"] not in ("active", "waiting")][:10]
    return {"active": active, "finished": finished}


@app.get("/api/invites/{code}")
def invite(code: str, db: DB):
    """What an invite link shows before the friend has entered a name."""
    game = _load(db, code)
    return {
        "code": game.code, "host": game.seats[0].player.name, "length": game.length,
        "open": game.mode == "team" and game.status == "waiting",
    }


@app.get("/api/games/{code}")
def get_game(code: str, player: Me, db: DB):
    game = _load(db, code)
    if rules.seat_of(game, player) is None and not (game.status == "waiting" and game.mode == "team"):
        raise HTTPException(403, "This game is between two other players.")
    return _view(game, player)


@app.post("/api/games/{code}/join")
async def join(code: str, player: Me, db: DB):
    game = _load(db, code)
    rules.join_game(db, game, player)
    await hub.send_state(game)
    return _view(game, player)


class MoveIn(BaseModel):
    word: str


@app.post("/api/games/{code}/moves")
async def move(code: str, body: MoveIn, player: Me, db: DB):
    game = _load(db, code)
    rules.play_move(db, game, player, body.word)
    await hub.send_state(game)
    return _view(game, player)


@app.post("/api/games/{code}/undo")
async def undo(code: str, player: Me, db: DB):
    game = _load(db, code)
    rules.undo(db, game, player)
    await hub.send_state(game)
    return _view(game, player)


@app.post("/api/games/{code}/hint")
async def hint(code: str, player: Me, db: DB):
    game = _load(db, code)
    result = rules.use_hint(db, game, player)
    await hub.send_state(game)
    return {**result, "game": _view(game, player)}


@app.post("/api/games/{code}/give-up")
async def give_up(code: str, player: Me, db: DB):
    game = _load(db, code)
    rules.give_up(db, game, player)
    await hub.send_state(game)
    return _view(game, player)


class AgainIn(BaseModel):
    length: int | None = None
    difficulty: str | None = None


@app.post("/api/games/{code}/again")
async def again(code: str, body: AgainIn, player: Me, db: DB):
    old = _load(db, code)
    new = rules.play_again(
        db, old, player, body.length or old.length, body.difficulty or old.difficulty or "medium"
    )
    await hub.send_event(old.code, {"type": "again", "code": new.code, "by": player.name}, except_player=player)
    return _view(new, player)


@app.websocket("/ws/games/{code}")
async def game_socket(ws: WebSocket, code: str):
    code = code.upper()
    with SessionLocal() as db:
        player = _player_from_token(db, ws.cookies.get(COOKIE))
        game = db.scalar(select(Game).where(Game.code == code))
        if player is None or game is None or rules.seat_of(game, player) is None:
            await ws.close(code=4403)
            return
        player_id = player.id
    await ws.accept()
    hub.connect(code, player_id, ws)
    try:
        await _broadcast_fresh(code)  # tells the partner we're online
        while True:
            await ws.receive_text()  # client pings keep the connection alive
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(code, player_id, ws)
        await _broadcast_fresh(code)


async def _broadcast_fresh(code: str) -> None:
    with SessionLocal() as db:
        game = db.scalar(select(Game).where(Game.code == code))
        if game:
            await hub.send_state(game)


# ---------- the web app ----------


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    # Served from the root so the service worker controls the whole site.
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/")
@app.get("/new")
@app.get("/g/{code}")
@app.get("/j/{code}")
def index(code: str | None = None):
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
