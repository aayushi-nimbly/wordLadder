"""Live updates: keeps each game's open WebSockets and pushes fresh state after every change."""

from __future__ import annotations

from collections import defaultdict

from fastapi import WebSocket

from . import rules
from .db import Game, Player


class Hub:
    def __init__(self) -> None:
        # game code -> player id -> open sockets (a player may have several tabs)
        self._rooms: dict[str, dict[int, set[WebSocket]]] = defaultdict(lambda: defaultdict(set))

    def online(self, code: str) -> set[int]:
        return {pid for pid, socks in self._rooms.get(code, {}).items() if socks}

    def connect(self, code: str, player_id: int, ws: WebSocket) -> None:
        self._rooms[code][player_id].add(ws)

    def disconnect(self, code: str, player_id: int, ws: WebSocket) -> None:
        room = self._rooms.get(code)
        if not room:
            return
        room[player_id].discard(ws)
        if not room[player_id]:
            del room[player_id]
        if not room:
            del self._rooms[code]

    async def send_state(self, game: Game) -> None:
        """Send every connected player their own view of the game."""
        online = self.online(game.code)
        for seat in game.seats:
            payload = {"type": "state", "game": rules.view(game, seat.player, online)}
            await self._send(game.code, seat.player_id, payload)

    async def send_event(self, code: str, payload: dict, except_player: Player | None = None) -> None:
        for pid in list(self._rooms.get(code, {})):
            if except_player is None or pid != except_player.id:
                await self._send(code, pid, payload)

    async def _send(self, code: str, player_id: int, payload: dict) -> None:
        for ws in list(self._rooms.get(code, {}).get(player_id, ())):
            try:
                await ws.send_json(payload)
            except Exception:
                self.disconnect(code, player_id, ws)


hub = Hub()
