"""Game rules: creating and joining games, moves, undo, hints, giving up, team stars and race results.

Modes:
  solo - one player, one ladder
  team - two players take turns on one shared ladder and win together
  race - two players each climb their own ladder for the same puzzle; fewest steps wins,
         then the faster time
  daily - today's puzzle, the same for everyone, played once per word length with a clock
          (see daily.py)

Every function here takes the acting player and raises RuleError with a message
that can be shown to them as-is.
"""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import engine
from .db import Game, GamePlayer, Move, Player, utcnow

MODES = ("solo", "team", "race")  # what players can create; daily games come from daily.py
CLOCKED = ("race", "daily")  # each player has their own ladder and a clock that starts on Start
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
HINTS_PER_GAME = 2


class RuleError(Exception):
    pass


def stars_for(steps: int, par: int) -> int:
    if steps <= par:
        return 3
    if steps <= par + 2:
        return 2
    return 1


def check_puzzle(length: int, start: str, end: str) -> int:
    """Validate a custom start and end word. Returns par."""
    start, end = start.strip().lower(), end.strip().lower()
    g = engine.graph(length)
    for label, w in (("Start", start), ("End", end)):
        if len(w) != length:
            raise RuleError(f"{label} word must have {length} letters.")
        if not g.is_word(w):
            raise RuleError(f"{w.upper()} isn't in the dictionary.")
    if start == end:
        raise RuleError("Start and end words must be different.")
    par = g.distance(start, end)
    if par is None:
        raise RuleError(f"There's no ladder from {start.upper()} to {end.upper()}. Try other words.")
    return par


def _new_code(db: Session) -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(5))
        if not db.scalar(select(Game.id).where(Game.code == code)):
            return code


def create_game(
    db: Session,
    player: Player,
    mode: str,
    length: int,
    difficulty: str | None,
    start: str | None = None,
    end: str | None = None,
    partner: Player | None = None,
) -> Game:
    if mode not in MODES:
        raise RuleError("Mode must be solo, team or race.")
    if length not in engine.LENGTHS:
        raise RuleError("Word length must be 4, 5 or 6.")
    if start and end:
        start, end = start.strip().lower(), end.strip().lower()
        par = check_puzzle(length, start, end)
        if difficulty not in engine.DIFFICULTIES:
            difficulty = None
    else:
        if difficulty not in engine.DIFFICULTIES:
            raise RuleError("Difficulty must be easy, medium or hard.")
        p = engine.graph(length).suggest(difficulty)
        start, end, par = p.start, p.end, p.par

    ready = mode == "solo" or partner is not None
    game = Game(
        code=_new_code(db),
        mode=mode,
        length=length,
        difficulty=difficulty,
        start_word=start,
        end_word=end,
        par=par,
        status="active" if ready else "waiting",
        hints_left=0 if mode == "race" else HINTS_PER_GAME,
    )
    game.seats.append(GamePlayer(player=player, seat=1, steps_used=0, gave_up=False))
    if partner is not None:
        game.seats.append(GamePlayer(player=partner, seat=2, steps_used=0, gave_up=False))
    db.add(game)
    db.commit()
    return game


def seat_of(game: Game, player: Player) -> int | None:
    return next((s.seat for s in game.seats if s.player_id == player.id), None)


def _seat(game: Game, seat: int) -> GamePlayer:
    return next(s for s in game.seats if s.seat == seat)


def join_game(db: Session, game: Game, player: Player) -> None:
    if seat_of(game, player):
        return
    if game.mode == "solo" or game.status != "waiting" or len(game.seats) >= 2:
        raise RuleError("This game already has two players.")
    game.seats.append(GamePlayer(player=player, seat=2, steps_used=0, gave_up=False))
    game.status = "active"
    game.updated_at = utcnow()
    db.commit()


def ladder(game: Game, seat: int | None = None) -> list[Move]:
    """The rungs played so far. In a race each seat has its own ladder."""
    return [m for m in game.moves if not m.undone and (game.mode not in CLOCKED or m.seat == seat)]


def current_word(game: Game, seat: int | None = None) -> str:
    rungs = ladder(game, seat)
    return rungs[-1].word if rungs else game.start_word


def _done(gp: GamePlayer) -> bool:
    return gp.finished_at is not None or bool(gp.gave_up)


def can_play(game: Game, seat: int | None) -> bool:
    if seat is None or game.status != "active":
        return False
    if game.mode in CLOCKED:
        gp = _seat(game, seat)
        return gp.started_at is not None and not _done(gp)
    return seat == game.turn_seat


def _require_turn(game: Game, player: Player) -> int:
    seat = seat_of(game, player)
    if seat is None:
        raise RuleError("You're not in this game.")
    if game.status == "waiting":
        raise RuleError("Waiting for your friend to join.")
    if game.status != "active":
        raise RuleError("This game is over.")
    if game.mode in CLOCKED:
        gp = _seat(game, seat)
        if gp.started_at is None:
            raise RuleError("Tap Start to begin.")
        if _done(gp):
            raise RuleError("You've already finished this one.")
    elif seat != game.turn_seat:
        raise RuleError("It's your friend's turn.")
    return seat


def start_race(db: Session, game: Game, player: Player) -> None:
    """Starts this player's clock. Each racer starts whenever they're ready."""
    seat = seat_of(game, player)
    if seat is None or game.mode not in CLOCKED:
        raise RuleError("This isn't a race you're in.")
    if game.status != "active":
        raise RuleError("Waiting for your friend to join." if game.status == "waiting" else "This race is over.")
    gp = _seat(game, seat)
    if gp.started_at is None:
        gp.started_at = utcnow()
        game.updated_at = utcnow()
        db.commit()


def _finish_race_if_done(game: Game) -> None:
    players = 1 if game.mode == "daily" else 2
    if len(game.seats) == players and all(_done(s) for s in game.seats):
        game.status = "finished"


def play_move(db: Session, game: Game, player: Player, word: str) -> Move:
    seat = _require_turn(game, player)
    word = word.strip().lower()
    here = current_word(game, seat)
    g = engine.graph(game.length)
    if len(word) != game.length or not word.isalpha():
        raise RuleError(f"Enter a {game.length}-letter word.")
    if word == here:
        raise RuleError("Change one letter.")
    if not engine.differs_by_one(here, word):
        diff = sum(a != b for a, b in zip(here, word))
        raise RuleError(f"Change only one letter. That changed {diff}.")
    if not g.is_word(word):
        raise RuleError(f"{word.upper()} isn't in the dictionary.")
    if word == game.start_word or word in {m.word for m in ladder(game, seat)}:
        raise RuleError(f"{word.upper()} is already on the ladder.")

    dist = g.distance(word, game.end_word)
    move = Move(seat=seat, word=word, distance_after=-1 if dist is None else dist)
    game.moves.append(move)
    game.updated_at = utcnow()
    if game.mode in CLOCKED:
        gp = _seat(game, seat)
        gp.steps_used = (gp.steps_used or 0) + 1
        if word == game.end_word:
            gp.finished_at = utcnow()
            _finish_race_if_done(game)
    else:
        game.steps_used += 1
        if word == game.end_word:
            game.status = "won"
            game.stars = stars_for(game.steps_used, game.par)
        elif game.mode == "team":
            game.turn_seat = 2 if seat == 1 else 1
    db.commit()
    return move


def undo(db: Session, game: Game, player: Player) -> None:
    """Step back one rung. The removed move still counts toward the steps."""
    seat = _require_turn(game, player)
    rungs = ladder(game, seat)
    if not rungs:
        raise RuleError("Nothing to undo yet.")
    rungs[-1].undone = True
    game.updated_at = utcnow()
    db.commit()


def use_hint(db: Session, game: Game, player: Player) -> dict:
    if game.mode in CLOCKED:
        raise RuleError("No hints in a race or the daily ladder.")
    seat = _require_turn(game, player)
    if game.hints_left <= 0:
        raise RuleError("No hints left in this game.")
    here = current_word(game, seat)
    step = engine.graph(game.length).next_step(here, game.end_word)
    if step is None:
        raise RuleError("No way forward from here. Try Undo.")
    game.hints_left -= 1
    db.commit()
    return {"position": engine.changed_position(here, step)}


def give_up(db: Session, game: Game, player: Player) -> None:
    seat = seat_of(game, player)
    if seat is None:
        raise RuleError("You're not in this game.")
    if game.status not in ("active", "waiting"):
        raise RuleError("This game is over.")
    if game.mode in CLOCKED and game.status == "active":
        gp = _seat(game, seat)
        if _done(gp):
            raise RuleError("You've already finished this race.")
        gp.gave_up = True
        _finish_race_if_done(game)
    else:
        game.status = "gave_up"
    game.updated_at = utcnow()
    db.commit()


def play_again(db: Session, game: Game, player: Player, length: int, difficulty: str) -> Game:
    if seat_of(game, player) is None:
        raise RuleError("You're not in this game.")
    if game.mode == "daily":
        raise RuleError("There's one daily ladder per day. Come back tomorrow!")
    partner = next((s.player for s in game.seats if s.player_id != player.id), None)
    return create_game(db, player, game.mode, length, difficulty, partner=partner)


# ---------- race results ----------


def _elapsed_ms(gp: GamePlayer) -> int | None:
    if gp.started_at is None or gp.finished_at is None:
        return None
    return int((gp.finished_at - gp.started_at).total_seconds() * 1000)


def race_winner(game: Game) -> int | None:
    """Seat of the winner: fewest steps, then fastest. None for a tie or if nobody finished."""
    finishers = [s for s in game.seats if s.finished_at is not None and not s.gave_up]
    if not finishers:
        return None
    ranked = sorted(finishers, key=lambda s: (s.steps_used or 0, _elapsed_ms(s)))
    if len(ranked) > 1 and (ranked[0].steps_used, _elapsed_ms(ranked[0])) == (ranked[1].steps_used, _elapsed_ms(ranked[1])):
        return None
    return ranked[0].seat


def race_outcome(game: Game, seat: int) -> str | None:
    """won | lost | tie | none (nobody finished), once the race is over."""
    if game.status != "finished":
        return None
    winner = race_winner(game)
    if winner is not None:
        return "won" if winner == seat else "lost"
    return "tie" if any(s.finished_at for s in game.seats) else "none"


def _race_view(game: Game, me: int | None) -> dict:
    over = game.status == "finished"
    seats = []
    for s in game.seats:
        mine = s.seat == me
        seats.append({
            "seat": s.seat,
            "steps": s.steps_used or 0,
            "started": s.started_at is not None,
            "started_at": s.started_at.isoformat() + "Z" if s.started_at and mine else None,
            "finished": s.finished_at is not None,
            "gave_up": bool(s.gave_up),
            "time_ms": _elapsed_ms(s),
            "stars": stars_for(s.steps_used or 0, game.par) if s.finished_at else None,
            # Opponents' words stay hidden until the race is over.
            "ladder": [m.word for m in ladder(game, s.seat)] if (mine or over) else None,
        })
    return {"seats": seats, "winner_seat": race_winner(game) if over else None,
            "outcome": race_outcome(game, me) if me else None}


def view(game: Game, player: Player, online: set[int] = frozenset()) -> dict:
    """Everything a player's screen needs, from their point of view."""
    me = seat_of(game, player)
    race = game.mode in CLOCKED
    g = engine.graph(game.length)
    here = current_word(game, me)
    distance = g.distance(here, game.end_word)
    finished = game.status in ("won", "gave_up", "finished")
    my_seat = _seat(game, me) if me else None
    out = {
        "code": game.code,
        "mode": game.mode,
        "length": game.length,
        "difficulty": game.difficulty,
        "start": game.start_word,
        "end": game.end_word,
        "par": game.par,
        "status": game.status,
        "turn_seat": game.turn_seat,
        "my_seat": me,
        "my_turn": can_play(game, me),
        "steps_used": (my_seat.steps_used or 0) if race and my_seat else game.steps_used,
        "hints_left": game.hints_left,
        "stars": game.stars,
        "current": here,
        "distance": distance,
        "players": [
            {"seat": s.seat, "name": s.player.name, "online": s.player_id in online, "me": s.player_id == player.id}
            for s in game.seats
        ],
        "ladder": [
            {"word": m.word, "seat": m.seat, "distance": m.distance_after} for m in ladder(game, me)
        ],
        "race": _race_view(game, me) if race else None,
        "solution": g.shortest_path(game.start_word, game.end_word) if finished else None,
        "updated_at": game.updated_at.isoformat() + "Z",
        "daily_date": game.daily_date,
    }
    # Today's words stay secret until you tap Start, so nobody can plan before the clock runs.
    if game.mode == "daily" and (my_seat is None or my_seat.started_at is None):
        out.update(start=None, end=None, current=None, distance=None, ladder=[])
    return out
