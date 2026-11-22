"""Daily ladder and leaderboards.

Every day (midnight India time) there is one puzzle, the same for everyone. The date decides its
word length (4, 5 or 6 letters) as well as its words. Each player gets one attempt: the clock starts on Start, there are no hints, and the result
is ranked by fewest steps, then fastest time.
"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import engine, rules
from .db import Game, GamePlayer, Player

TZ = ZoneInfo("Asia/Kolkata")
DIFFICULTY = "medium"
SALT = "wordladder-daily-v1"  # change to reshuffle every future puzzle


def today() -> date:
    return datetime.now(TZ).date()


def seconds_until_reset() -> int:
    now = datetime.now(TZ)
    tomorrow = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), TZ)
    return int((tomorrow - now).total_seconds())


def length_for(day: date) -> int:
    return random.Random(f"{SALT}:{day.isoformat()}:length").choice(engine.LENGTHS)


@lru_cache(maxsize=64)
def puzzle(day: date) -> engine.Puzzle:
    """The same puzzle for everyone on `day`, chosen from the date alone."""
    length = length_for(day)
    return engine.graph(length).suggest(DIFFICULTY, random.Random(f"{SALT}:{day.isoformat()}:{length}"))


# ---------- playing ----------


def _todays_games(day: date):
    """Daily games for `day` that are for that day's puzzle (ignores attempts at an older version of it)."""
    p = puzzle(day)
    return (Game.mode == "daily", Game.daily_date == day.isoformat(),
            Game.start_word == p.start, Game.end_word == p.end)


def _my_daily(db: Session, player: Player, day: date) -> Game | None:
    return db.scalar(select(Game).join(GamePlayer).where(*_todays_games(day), GamePlayer.player_id == player.id))


def open_daily(db: Session, player: Player) -> Game:
    """This player's attempt at today's ladder, created on first open."""
    day = today()
    game = _my_daily(db, player, day)
    if game:
        return game
    p = puzzle(day)
    game = Game(
        code=rules._new_code(db), mode="daily", length=len(p.start), difficulty=DIFFICULTY,
        start_word=p.start, end_word=p.end, par=p.par, status="active", hints_left=0,
        daily_date=day.isoformat(),
    )
    game.seats.append(GamePlayer(player=player, seat=1, steps_used=0, gave_up=False))
    db.add(game)
    db.commit()
    return game


# ---------- leaderboards ----------


def _results(db: Session, day_from: date, day_to: date):
    """(game, seat) for every daily attempt that has finished or been given up in the date range."""
    q = (
        select(Game, GamePlayer)
        .join(GamePlayer, GamePlayer.game_id == Game.id)
        .where(Game.mode == "daily", Game.daily_date >= day_from.isoformat(), Game.daily_date <= day_to.isoformat())
    )
    return [(g, s) for g, s in db.execute(q).all()
            if (s.finished_at or s.gave_up) and (g.start_word, g.end_word) == _words(g.daily_date)]


def _words(iso: str) -> tuple[str, str]:
    p = puzzle(date.fromisoformat(iso))
    return p.start, p.end


def _time_ms(seat: GamePlayer) -> int:
    return rules._elapsed_ms(seat) or 0


def day_board(db: Session, player: Player | None, day: date | None = None) -> dict:
    day = day or today()
    finished, gave_up = [], []
    for game, seat in _results(db, day, day):
        row = {"name": seat.player.name, "me": player is not None and seat.player_id == player.id,
               "steps": seat.steps_used or 0, "time_ms": _time_ms(seat)}
        if seat.gave_up:
            gave_up.append({**row, "rank": None, "stars": None, "gave_up": True})
        else:
            finished.append({**row, "stars": rules.stars_for(row["steps"], game.par), "gave_up": False})
    finished.sort(key=lambda r: (r["steps"], r["time_ms"]))
    for i, row in enumerate(finished):
        # Equal steps and time share a rank.
        same = i and (row["steps"], row["time_ms"]) == (finished[i - 1]["steps"], finished[i - 1]["time_ms"])
        row["rank"] = finished[i - 1]["rank"] if same else i + 1
    rows = finished + gave_up
    p = puzzle(day)
    return {"date": day.isoformat(), "length": len(p.start), "par": p.par, "played": len(rows),
            "rows": rows, "me": next((r for r in rows if r["me"]), None)}


def week_board(db: Session, player: Player | None) -> dict:
    """Stars from daily ladders since Monday; ties go to the lower total time."""
    end = today()
    start = end - timedelta(days=end.weekday())
    totals: dict[int, dict] = {}
    for game, seat in _results(db, start, end):
        t = totals.setdefault(seat.player_id, {
            "name": seat.player.name, "me": player is not None and seat.player_id == player.id,
            "stars": 0, "days": set(), "ladders": 0, "time_ms": 0})
        t["days"].add(game.daily_date)
        if not seat.gave_up:
            t["stars"] += rules.stars_for(seat.steps_used or 0, game.par)
            t["ladders"] += 1
            t["time_ms"] += _time_ms(seat)
    rows = sorted(totals.values(), key=lambda r: (-r["stars"], r["time_ms"]))
    for i, r in enumerate(rows):
        r["days"] = len(r["days"])
        r["rank"] = i + 1
    return {"from": start.isoformat(), "to": end.isoformat(), "days_so_far": end.weekday() + 1,
            "rows": rows, "me": next((r for r in rows if r["me"]), None)}


def friends_board(db: Session, player: Player) -> dict:
    """Your record with everyone you've played a race or team game with."""
    games = db.scalars(
        select(Game).join(GamePlayer).where(GamePlayer.player_id == player.id, Game.mode.in_(("race", "team")))
    ).all()
    friends: dict[int, dict] = {}
    for g in games:
        other = next((s for s in g.seats if s.player_id != player.id), None)
        if other is None:
            continue
        f = friends.setdefault(other.player_id, {
            "name": other.player.name, "won": 0, "lost": 0, "tied": 0, "team_games": 0, "team_stars": 0})
        if g.mode == "race" and g.status == "finished":
            outcome = rules.race_outcome(g, rules.seat_of(g, player))
            f[{"won": "won", "lost": "lost"}.get(outcome, "tied")] += 1
        elif g.mode == "team" and g.status == "won":
            f["team_games"] += 1
            f["team_stars"] += g.stars or 0
    rows = []
    for f in friends.values():
        avg = round(f.pop("team_stars") / f["team_games"], 1) if f["team_games"] else None
        rows.append({**f, "avg_stars": avg})
    rows.sort(key=lambda r: (-(r["won"] + r["lost"] + r["tied"] + r["team_games"]), r["name"].lower()))
    return {"rows": rows}


def streak(db: Session, player: Player) -> int:
    """Days in a row with at least one finished daily ladder, counting back from today
    (or from yesterday, if today's isn't done yet)."""
    days = set(db.scalars(
        select(Game.daily_date).join(GamePlayer).where(
            Game.mode == "daily", GamePlayer.player_id == player.id, GamePlayer.finished_at.is_not(None))
    ).all())
    day = today()
    if day.isoformat() not in days:
        day -= timedelta(days=1)
    count = 0
    while day.isoformat() in days:
        count += 1
        day -= timedelta(days=1)
    return count


def overview(db: Session, player: Player) -> dict:
    """What the home screen's daily card needs."""
    day = today()
    p = puzzle(day)
    played = db.scalar(
        select(func.count(GamePlayer.id)).join(Game).where(*_todays_games(day), GamePlayer.started_at.is_not(None))
    )
    game = _my_daily(db, player, day)
    mine = None
    if game:
        seat = game.seats[0]
        mine = {"code": game.code, "status": game.status, "started": seat.started_at is not None,
                "steps": seat.steps_used or 0, "time_ms": rules._elapsed_ms(seat), "gave_up": bool(seat.gave_up),
                "stars": rules.stars_for(seat.steps_used or 0, game.par) if seat.finished_at else None}
        if game.status == "finished" and not seat.gave_up:
            board = day_board(db, player, day)
            mine["rank"], mine["of"] = board["me"]["rank"], len([r for r in board["rows"] if not r["gave_up"]])
    return {"date": day.isoformat(), "resets_in": seconds_until_reset(), "streak": streak(db, player),
            "length": len(p.start), "par": p.par, "played": played or 0, "mine": mine}


__all__ = ["day_board", "friends_board", "length_for", "open_daily", "overview", "puzzle", "streak", "today", "week_board"]
