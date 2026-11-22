"""Accounts: Google sign-in, unique usernames, signed-in devices, and deleting an account.

Each signed-in device holds a random token in a cookie; only its hash is stored, so a player can be
signed in on several devices at once.
"""

from __future__ import annotations

import hashlib
import re
import secrets

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .db import LoginSession, Player, PushSubscription

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,20}$")


class AccountError(Exception):
    pass


# ---------- usernames ----------


def clean_username(raw: str) -> str:
    name = (raw or "").strip()
    if not USERNAME_RE.match(name):
        raise AccountError("Usernames are 3–20 letters or numbers (you can use _ . -), no spaces.")
    return name


def is_taken(db: Session, name: str, player: Player | None = None) -> bool:
    other = db.scalar(select(Player).where(Player.name_key == name.lower()))
    return other is not None and (player is None or other.id != player.id)


def set_username(db: Session, player: Player, raw: str) -> None:
    name = clean_username(raw)
    if is_taken(db, name, player):
        raise AccountError("That username is taken. Try another.")
    player.name, player.name_key = name, name.lower()
    db.commit()


def suggest_username(db: Session, hint: str | None) -> str:
    """A free username based on the player's Google first name, e.g. "Aayushi" or "Aayushi2"."""
    base = re.sub(r"[^A-Za-z0-9_.-]", "", (hint or "").split(" ")[0])[:16] or "player"
    if len(base) < 3:
        base = (base + "player")[:16]
    if not is_taken(db, base):
        return base
    for n in range(2, 1000):
        if not is_taken(db, f"{base}{n}"):
            return f"{base}{n}"
    return f"{base}{secrets.randbelow(10**4)}"


# ---------- Google ----------


def player_for_google(db: Session, sub: str, email: str | None) -> Player:
    """The account linked to this Google account, created on first sign-in."""
    player = db.scalar(select(Player).where(Player.google_sub == sub))
    if player is None:
        player = Player(google_sub=sub, email=email)
        db.add(player)
    else:
        player.email = email
    db.commit()
    return player


def delete_account(db: Session, player: Player) -> None:
    """Remove personal data. Finished games stay so friends' records still make sense, shown as a
    deleted player."""
    player.google_sub = None
    player.email = None
    player.name = "deleted"
    player.name_key = f"deleted-{player.id}"
    db.execute(delete(LoginSession).where(LoginSession.player_id == player.id))
    db.execute(delete(PushSubscription).where(PushSubscription.player_id == player.id))
    db.commit()


# ---------- signed-in devices ----------


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(db: Session, player: Player) -> str:
    token = secrets.token_urlsafe(32)
    db.add(LoginSession(player_id=player.id, token_hash=_hash(token)))
    db.commit()
    return token


def player_for(db: Session, token: str | None) -> Player | None:
    if not token:
        return None
    s = db.scalar(select(LoginSession).where(LoginSession.token_hash == _hash(token)))
    return s.player if s else None


def end_session(db: Session, token: str | None) -> None:
    if not token:
        return
    s = db.scalar(select(LoginSession).where(LoginSession.token_hash == _hash(token)))
    if s:
        db.delete(s)
        db.commit()
