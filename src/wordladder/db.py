"""Database setup and tables. SQLite locally; set WORDLADDER_DB to a Postgres URL in production."""

from __future__ import annotations

import os
from datetime import datetime, timezone

from sqlalchemy import ForeignKey, String, UniqueConstraint, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

DB_URL = os.environ.get("WORDLADDER_DB", "sqlite:///./wordladder.db")


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Player(Base):
    __tablename__ = "players"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(24))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class Game(Base):
    __tablename__ = "games"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(8), unique=True, index=True)
    mode: Mapped[str] = mapped_column(String(8))  # solo | team
    length: Mapped[int]
    difficulty: Mapped[str | None] = mapped_column(String(8))  # None for custom words
    start_word: Mapped[str] = mapped_column(String(8))
    end_word: Mapped[str] = mapped_column(String(8))
    par: Mapped[int]
    status: Mapped[str] = mapped_column(String(10))  # waiting | active | won | gave_up
    turn_seat: Mapped[int] = mapped_column(default=1)
    steps_used: Mapped[int] = mapped_column(default=0)
    hints_left: Mapped[int] = mapped_column(default=2)
    stars: Mapped[int | None]
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow)

    seats: Mapped[list[GamePlayer]] = relationship(
        back_populates="game", order_by="GamePlayer.seat", cascade="all, delete-orphan"
    )
    moves: Mapped[list[Move]] = relationship(
        back_populates="game", order_by="Move.id", cascade="all, delete-orphan"
    )


class GamePlayer(Base):
    __tablename__ = "game_players"
    __table_args__ = (UniqueConstraint("game_id", "seat"), UniqueConstraint("game_id", "player_id"))

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    seat: Mapped[int]

    game: Mapped[Game] = relationship(back_populates="seats")
    player: Mapped[Player] = relationship()


class Move(Base):
    __tablename__ = "moves"

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id"), index=True)
    seat: Mapped[int]
    word: Mapped[str] = mapped_column(String(8))
    distance_after: Mapped[int]
    undone: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    game: Mapped[Game] = relationship(back_populates="moves")


engine = create_engine(
    DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {}
)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_db():
    with SessionLocal() as session:
        yield session


__all__ = ["Base", "Game", "GamePlayer", "Move", "Player", "Session", "get_db", "init_db"]
