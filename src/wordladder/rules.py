"""Game rules: creating and joining games, moves, undo, hints, giving up, and team stars.

Every function here takes the acting player and raises RuleError with a message
that can be shown to them as-is.
"""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import engine
from .db import Game, GamePlayer, Move, Player, utcnow

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
    if mode not in ("solo", "team"):
        raise RuleError("Mode must be solo or team.")
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
        hints_left=HINTS_PER_GAME,
    )
    game.seats.append(GamePlayer(player=player, seat=1))
    if partner is not None:
        game.seats.append(GamePlayer(player=partner, seat=2))
    db.add(game)
    db.commit()
    return game


def seat_of(game: Game, player: Player) -> int | None:
    return next((s.seat for s in game.seats if s.player_id == player.id), None)


def join_game(db: Session, game: Game, player: Player) -> None:
    if seat_of(game, player):
        return
    if game.mode != "team" or game.status != "waiting" or len(game.seats) >= 2:
        raise RuleError("This game already has two players.")
    game.seats.append(GamePlayer(player=player, seat=2))
    game.status = "active"
    game.updated_at = utcnow()
    db.commit()


def ladder(game: Game) -> list[Move]:
    return [m for m in game.moves if not m.undone]


def current_word(game: Game) -> str:
    rungs = ladder(game)
    return rungs[-1].word if rungs else game.start_word


def _require_turn(game: Game, player: Player) -> int:
    seat = seat_of(game, player)
    if seat is None:
        raise RuleError("You're not in this game.")
    if game.status == "waiting":
        raise RuleError("Waiting for your friend to join.")
    if game.status != "active":
        raise RuleError("This game is over.")
    if seat != game.turn_seat:
        raise RuleError("It's your friend's turn.")
    return seat


def play_move(db: Session, game: Game, player: Player, word: str) -> Move:
    seat = _require_turn(game, player)
    word = word.strip().lower()
    here = current_word(game)
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
    if word == game.start_word or word in {m.word for m in ladder(game)}:
        raise RuleError(f"{word.upper()} is already on the ladder.")

    dist = g.distance(word, game.end_word)
    move = Move(seat=seat, word=word, distance_after=-1 if dist is None else dist)
    game.moves.append(move)
    game.steps_used += 1
    game.updated_at = utcnow()
    if word == game.end_word:
        game.status = "won"
        game.stars = stars_for(game.steps_used, game.par)
    elif game.mode == "team":
        game.turn_seat = 2 if seat == 1 else 1
    db.commit()
    return move


def undo(db: Session, game: Game, player: Player) -> None:
    """Step back one rung. The removed move still counts toward the team's steps."""
    _require_turn(game, player)
    rungs = ladder(game)
    if not rungs:
        raise RuleError("Nothing to undo yet.")
    rungs[-1].undone = True
    game.updated_at = utcnow()
    db.commit()


def use_hint(db: Session, game: Game, player: Player) -> dict:
    _require_turn(game, player)
    if game.hints_left <= 0:
        raise RuleError("No hints left in this game.")
    here = current_word(game)
    step = engine.graph(game.length).next_step(here, game.end_word)
    if step is None:
        raise RuleError("No way forward from here. Try Undo.")
    game.hints_left -= 1
    db.commit()
    return {"position": engine.changed_position(here, step)}


def give_up(db: Session, game: Game, player: Player) -> None:
    if seat_of(game, player) is None:
        raise RuleError("You're not in this game.")
    if game.status not in ("active", "waiting"):
        raise RuleError("This game is over.")
    game.status = "gave_up"
    game.updated_at = utcnow()
    db.commit()


def play_again(db: Session, game: Game, player: Player, length: int, difficulty: str) -> Game:
    if seat_of(game, player) is None:
        raise RuleError("You're not in this game.")
    partner = next((s.player for s in game.seats if s.player_id != player.id), None)
    return create_game(db, player, game.mode, length, difficulty, partner=partner)


def view(game: Game, player: Player, online: set[int] = frozenset()) -> dict:
    """Everything a player's screen needs, from their point of view."""
    me = seat_of(game, player)
    g = engine.graph(game.length)
    here = current_word(game)
    distance = g.distance(here, game.end_word)
    finished = game.status in ("won", "gave_up")
    return {
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
        "my_turn": game.status == "active" and me == game.turn_seat,
        "steps_used": game.steps_used,
        "hints_left": game.hints_left,
        "stars": game.stars,
        "current": here,
        "distance": distance,
        "players": [
            {"seat": s.seat, "name": s.player.name, "online": s.player_id in online, "me": s.player_id == player.id}
            for s in game.seats
        ],
        "ladder": [
            {"word": m.word, "seat": m.seat, "distance": m.distance_after} for m in ladder(game)
        ],
        "solution": g.shortest_path(game.start_word, game.end_word) if finished else None,
        "updated_at": game.updated_at.isoformat() + "Z",
    }
