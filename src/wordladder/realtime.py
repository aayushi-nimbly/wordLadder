"""Live updates: keeps each game's open WebSockets and pushes fresh state after every change."""

from __future__ import annotations

from collections import defaultdict

from fastapi import WebSocket

from . import rules
from .db import Game, Player


class Hub:
    def __init__(self) -> None:
        # game code -> player id -> open sockets (a player may have several tabs), each with
        # whether that tab is on screen. A hidden tab or a locked phone keeps its socket for a
        # while, but the player isn't watching, so they should still get a notification.
        self._rooms: dict[str, dict[int, dict[WebSocket, bool]]] = defaultdict(lambda: defaultdict(dict))

    def online(self, code: str) -> set[int]:
        """Players who have this game open and on screen right now."""
        return {pid for pid, socks in self._rooms.get(code, {}).items() if any(socks.values())}

    def connect(self, code: str, player_id: int, ws: WebSocket) -> None:
        self._rooms[code][player_id][ws] = True

    def set_visible(self, code: str, player_id: int, ws: WebSocket, visible: bool) -> bool:
        """Returns True if the player's online status changed."""
        room = self._rooms.get(code)
        if not room or ws not in room.get(player_id, {}):
            return False
        before = player_id in self.online(code)
        room[player_id][ws] = visible
        return before != (player_id in self.online(code))

    def disconnect(self, code: str, player_id: int, ws: WebSocket) -> None:
        room = self._rooms.get(code)
        if not room:
            return
        room[player_id].pop(ws, None)
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
