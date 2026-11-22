"""Database setup and tables. SQLite locally; set WORDLADDER_DB to a Postgres URL in production."""

from __future__ import annotations

import os
from datetime import datetime, timezone

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint, create_engine, inspect, text
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
    reminded_at: Mapped[datetime | None]  # last "still your turn" reminder

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


class PushSubscription(Base):
    """One browser or installed app that agreed to receive notifications."""

    __tablename__ = "push_subscriptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), index=True)
    endpoint: Mapped[str] = mapped_column(Text, unique=True)
    p256dh: Mapped[str] = mapped_column(String(200))
    auth: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


engine = create_engine(
    DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {}
)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)
    _add_missing_columns()


def _add_missing_columns() -> None:
    """create_all doesn't touch existing tables; add new nullable columns so old databases keep working."""
    existing = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            have = {c["name"] for c in existing.get_columns(table.name)}
            for col in table.columns:
                if col.name not in have and col.nullable:
                    kind = col.type.compile(dialect=engine.dialect)
                    conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{col.name}" {kind}'))


def get_db():
    with SessionLocal() as session:
        yield session


__all__ = ["Base", "Game", "GamePlayer", "Move", "Player", "PushSubscription", "Session", "get_db", "init_db"]
