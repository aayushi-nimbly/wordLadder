"""FastAPI app: JSON API, the live WebSocket, and the installable web app."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import accounts, daily, engine, google, push, rules
from .db import Game, GamePlayer, Player, PushSubscription, SessionLocal, get_db, init_db
from .realtime import hub

STATIC = Path(__file__).parent / "static"
COOKIE = "wl_token"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    for n in engine.LENGTHS:  # build word graphs before the first request
        engine.graph(n)
    push.vapid()
    reminders = asyncio.create_task(push.reminder_loop())
    yield
    reminders.cancel()


app = FastAPI(title="Word Ladder", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

DB = Annotated[Session, Depends(get_db)]


@app.exception_handler(rules.RuleError)
async def rule_error(_: Request, exc: rules.RuleError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ---------- accounts (Google sign-in) ----------

DEV_LOGIN = os.environ.get("WORDLADDER_DEV_LOGIN") == "1"  # local browser tests only; never set on Render
HINT_COOKIE = "wl_name_hint"  # Google first name, to suggest a username right after sign-up
OAUTH_COOKIE = "wl_oauth"  # state, PKCE verifier and where to go next, during the Google round trip


def _player_from_token(db: Session, token: str | None) -> Player | None:
    return accounts.player_for(db, token)


def current_player(request: Request, db: DB) -> Player:
    player = _player_from_token(db, request.cookies.get(COOKIE))
    if player is None:
        raise HTTPException(401, "Sign in to play.")
    if not player.name:
        raise HTTPException(403, "Pick a username first.")
    return player


Me = Annotated[Player, Depends(current_player)]


@app.exception_handler(accounts.AccountError)
async def account_error(_: Request, exc: accounts.AccountError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


def _safe_next(path: str | None) -> str:
    """Only ever send people back to a page on this site."""
    return path if path and path.startswith("/") and not path.startswith("//") else "/"


def _cookie(response: Response, request: Request, key: str, value: str, max_age: int) -> None:
    response.set_cookie(key, value, max_age=max_age, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https")


def _redirect_uri(request: Request) -> str:
    return f"{request.url.scheme}://{request.url.netloc}/auth/google/callback"


@app.get("/auth/google/login")
def google_login(request: Request, next: str | None = None):
    url, state, verifier = google.start(_redirect_uri(request))
    response = RedirectResponse(url, status_code=302)
    _cookie(response, request, OAUTH_COOKIE, json.dumps([state, verifier, _safe_next(next)]), 600)
    return response


@app.get("/auth/google/callback")
def google_callback(request: Request, db: DB, code: str | None = None, state: str | None = None,
                    error: str | None = None):
    try:
        saved_state, verifier, next_path = json.loads(request.cookies.get(OAUTH_COOKIE, "[]"))
    except ValueError:
        saved_state, verifier, next_path = None, None, "/"
    if error or not code:
        return RedirectResponse("/?signin=cancelled", status_code=302)
    if not saved_state or not secrets.compare_digest(saved_state, state or ""):
        return RedirectResponse("/?signin=expired", status_code=302)
    try:
        claims = google.finish(code, verifier, _redirect_uri(request))
    except google.GoogleError:
        return RedirectResponse("/?signin=failed", status_code=302)
    player = accounts.player_for_google(db, claims["sub"], claims.get("email"))
    return _signed_in(request, db, player, claims.get("given_name") or claims.get("name"), next_path)


def _signed_in(request: Request, db: Session, player: Player, name_hint: str | None, next_path: str):
    response = RedirectResponse(_safe_next(next_path), status_code=302)
    _cookie(response, request, COOKIE, accounts.start_session(db, player), COOKIE_MAX_AGE)
    response.delete_cookie(OAUTH_COOKIE)
    if not player.name and name_hint:
        _cookie(response, request, HINT_COOKIE, name_hint[:40], 3600)
    return response


if DEV_LOGIN:
    @app.get("/auth/dev-login")
    def dev_login(request: Request, db: DB, sub: str, name: str = "", next: str = "/"):
        """Stand-in for Google in local browser tests."""
        player = accounts.player_for_google(db, f"dev-{sub}", f"{sub}@example.com")
        return _signed_in(request, db, player, name or sub, next)


@app.get("/api/me")
def me(request: Request, db: DB):
    player = _player_from_token(db, request.cookies.get(COOKIE))
    if player is None:
        raise HTTPException(401, "Sign in to play.")
    out = {"id": player.id, "name": player.name, "email": player.email, "needs_username": not player.name}
    if not player.name:
        out["suggestion"] = accounts.suggest_username(db, request.cookies.get(HINT_COOKIE))
    return out


class UsernameIn(BaseModel):
    username: str = Field(max_length=40)


@app.post("/api/username")
def choose_username(body: UsernameIn, request: Request, db: DB):
    player = _player_from_token(db, request.cookies.get(COOKIE))
    if player is None:
        raise HTTPException(401, "Sign in to play.")
    if player.name:
        raise HTTPException(400, "You already have a username.")
    accounts.set_username(db, player, body.username)
    return {"id": player.id, "name": player.name, "email": player.email, "needs_username": False}


@app.post("/api/logout")
def log_out(request: Request, response: Response, db: DB):
    accounts.end_session(db, request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.post("/api/account/delete")
def delete_account(request: Request, response: Response, db: DB):
    player = _player_from_token(db, request.cookies.get(COOKIE))
    if player is None:
        raise HTTPException(401, "Sign in to play.")
    accounts.delete_account(db, player)
    response.delete_cookie(COOKIE)
    return {"ok": True}


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


def _notify(bg: BackgroundTasks, game: Game, actor: Player, event: str, new_game: Game | None = None) -> None:
    notes = push.notes_for(game, actor.id, event, hub.online(game.code), new_game)
    if notes:
        bg.add_task(push.send_now, notes)


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
        select(Game).join(GamePlayer)
        .where(GamePlayer.player_id == player.id, Game.mode != "daily")  # dailies live on their own card
        .order_by(Game.updated_at.desc())
    ).all()
    out = []
    for g in games:
        partner = next((s.player.name for s in g.seats if s.player_id != player.id), None)
        me_seat = rules.seat_of(g, player)
        race = g.mode == "race"
        out.append({
            "code": g.code, "mode": g.mode, "status": g.status, "length": g.length,
            "start": g.start_word, "end": g.end_word, "par": g.par, "stars": g.stars,
            "steps_used": g.steps_used, "partner": partner,
            # In a race you can always play until you've finished.
            "my_turn": g.status == "active" and (
                not rules._done(rules._seat(g, me_seat)) if race else g.turn_seat == me_seat),
            "outcome": rules.race_outcome(g, me_seat) if race else None,
            "updated_at": g.updated_at.isoformat() + "Z",
        })
    rank = {"my_turn": 0, "waiting": 1, "their_turn": 2, "won": 3, "gave_up": 3, "finished": 3}
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
        "mode": game.mode,
        "open": game.mode != "solo" and game.status == "waiting",
    }


@app.get("/api/games/{code}")
def get_game(code: str, player: Me, db: DB):
    game = _load(db, code)
    if rules.seat_of(game, player) is None and not (game.status == "waiting" and game.mode != "solo"):
        raise HTTPException(403, "This game is between two other players.")
    return _view(game, player)


@app.post("/api/games/{code}/join")
async def join(code: str, player: Me, db: DB, bg: BackgroundTasks):
    game = _load(db, code)
    rules.join_game(db, game, player)
    await hub.send_state(game)
    _notify(bg, game, player, "joined")
    return _view(game, player)


class MoveIn(BaseModel):
    word: str


@app.post("/api/games/{code}/moves")
async def move(code: str, body: MoveIn, player: Me, db: DB, bg: BackgroundTasks):
    game = _load(db, code)
    rules.play_move(db, game, player, body.word)
    await hub.send_state(game)
    _notify(bg, game, player, "move")
    return _view(game, player)


@app.post("/api/games/{code}/start")
async def start(code: str, player: Me, db: DB):
    game = _load(db, code)
    rules.start_race(db, game, player)
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
async def give_up(code: str, player: Me, db: DB, bg: BackgroundTasks):
    game = _load(db, code)
    rules.give_up(db, game, player)
    await hub.send_state(game)
    _notify(bg, game, player, "gave_up")
    return _view(game, player)


class AgainIn(BaseModel):
    length: int | None = None
    difficulty: str | None = None


@app.post("/api/games/{code}/again")
async def again(code: str, body: AgainIn, player: Me, db: DB, bg: BackgroundTasks):
    old = _load(db, code)
    new = rules.play_again(
        db, old, player, body.length or old.length, body.difficulty or old.difficulty or "medium"
    )
    await hub.send_event(old.code, {"type": "again", "code": new.code, "by": player.name}, except_player=player)
    _notify(bg, old, player, "again", new)
    return _view(new, player)


# ---------- daily ladder and leaderboards ----------


@app.get("/api/daily")
def daily_overview(player: Me, db: DB):
    return daily.overview(db, player)


@app.post("/api/daily")
def daily_open(player: Me, db: DB):
    return _view(daily.open_daily(db, player), player)


@app.get("/api/leaderboard/today")
def leaderboard_today(request: Request, db: DB):
    return daily.day_board(db, _player_from_token(db, request.cookies.get(COOKIE)))


@app.get("/api/leaderboard/week")
def leaderboard_week(request: Request, db: DB):
    return daily.week_board(db, _player_from_token(db, request.cookies.get(COOKIE)))


@app.get("/api/leaderboard/friends")
def leaderboard_friends(player: Me, db: DB):
    return daily.friends_board(db, player)


# ---------- notifications ----------


@app.get("/api/push/key")
def push_key():
    return {"key": push.public_key()}


class SubKeys(BaseModel):
    p256dh: str = Field(max_length=200)
    auth: str = Field(max_length=100)


class SubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000)
    keys: SubKeys


@app.post("/api/push/subscribe")
def push_subscribe(body: SubscriptionIn, player: Me, db: DB):
    if not body.endpoint.startswith("https://"):
        raise HTTPException(400, "That isn't a push subscription.")
    sub = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
    if sub is None:
        sub = PushSubscription(endpoint=body.endpoint)
        db.add(sub)
    sub.player_id = player.id  # a device belongs to whoever last used it
    sub.p256dh, sub.auth = body.keys.p256dh, body.keys.auth
    db.commit()
    return {"ok": True}


class EndpointIn(BaseModel):
    endpoint: str


@app.post("/api/push/unsubscribe")
def push_unsubscribe(body: EndpointIn, player: Me, db: DB):
    sub = db.scalar(select(PushSubscription).where(
        PushSubscription.endpoint == body.endpoint, PushSubscription.player_id == player.id
    ))
    if sub:
        db.delete(sub)
        db.commit()
    return {"ok": True}


@app.post("/api/push/test")
async def push_test(player: Me, db: DB):
    """Sends a test notification to all of this player's devices and says what happened."""
    devices = len(db.scalars(select(PushSubscription.id).where(PushSubscription.player_id == player.id)).all())
    problems: list[str] = []
    note = push.Note(player.id, "Notifications work", "We'll tell you when it's your turn.", "/", "test")
    sent = await asyncio.to_thread(push.send_now, [note], problems)
    return {"devices": devices, "sent": sent, "problems": problems}


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
            msg = await ws.receive_text()  # "ping" keeps the connection alive
            if msg in ("visible", "hidden") and hub.set_visible(code, player_id, ws, msg == "visible"):
                await _broadcast_fresh(code)
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


@app.get("/healthz")
def healthz(db: DB):
    db.execute(select(1))
    return {"ok": True}


# ---------- the web app ----------


@app.get("/privacy")
def privacy():
    return FileResponse(STATIC / "privacy.html", headers={"Cache-Control": "no-cache"})


@app.get("/terms")
def terms():
    return FileResponse(STATIC / "terms.html", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    # Served from the root so the service worker controls the whole site.
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/")
@app.get("/new")
@app.get("/help")
@app.get("/account")
@app.get("/welcome")
@app.get("/leaderboard")
@app.get("/tutorial")
@app.get("/g/{code}")
@app.get("/j/{code}")
def index(code: str | None = None):
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
