"""Word engine: dictionaries, the one-letter-apart graph, shortest paths and puzzle suggestions."""

from __future__ import annotations

import random
from collections import defaultdict, deque
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

LENGTHS = (4, 5, 6)
DIFFICULTIES = ("easy", "medium", "hard")
DATA_DIR = Path(__file__).parent / "data"

# Par (shortest number of moves) wanted for each difficulty, per word length.
PAR_RANGES: dict[int, dict[str, tuple[int, int]]] = {
    4: {"easy": (3, 4), "medium": (5, 6), "hard": (7, 12)},
    5: {"easy": (3, 4), "medium": (5, 6), "hard": (7, 14)},
    6: {"easy": (4, 5), "medium": (6, 7), "hard": (8, 16)},
}


@dataclass(frozen=True)
class Puzzle:
    start: str
    end: str
    par: int


class WordGraph:
    """All valid words of one length, linked when they differ by exactly one letter.

    Three word tiers:
      valid  - every accepted word
      known  - words most people recognise; hints and solutions stick to these when they can
      common - everyday words; the only ones suggested as start or end words
    """

    def __init__(self, length: int, valid: list[str], known: list[str], common: list[str]):
        self.length = length
        self.valid = frozenset(valid)
        self.known = frozenset(known) & self.valid
        self.common = [w for w in common if w in self.known]
        self.neighbours = self._build(valid)

    @staticmethod
    def _build(words: list[str]) -> dict[str, list[str]]:
        # Bucket by wildcard pattern: "cold" sits in "_old", "c_ld", "co_d", "col_".
        buckets: dict[str, list[str]] = defaultdict(list)
        for w in words:
            for i in range(len(w)):
                buckets[w[:i] + "_" + w[i + 1 :]].append(w)
        graph: dict[str, list[str]] = {w: [] for w in words}
        for group in buckets.values():
            for w in group:
                graph[w].extend(x for x in group if x != w)
        return graph

    def is_word(self, word: str) -> bool:
        return word in self.valid

    def distances_from(self, source: str, known_only: bool = False) -> dict[str, int]:
        return _distances(self, source, known_only)

    def distance(self, a: str, b: str) -> int | None:
        """Fewest moves from a to b using any valid words."""
        return self.distances_from(b).get(a)

    def shortest_path(self, a: str, b: str) -> list[str] | None:
        """One shortest ladder from a to b, made of familiar words whenever that is possible."""
        full = self.distances_from(b)
        if a not in full:
            return None
        known = self.distances_from(b, known_only=True)
        if known.get(a) == full[a]:
            dist, allowed = known, self.known | {a}
        else:
            dist, allowed = full, self.valid
        path = [a]
        while path[-1] != b:
            here = dist[path[-1]]
            steps = sorted(n for n in self.neighbours[path[-1]] if n in allowed and dist.get(n) == here - 1)
            path.append(steps[0])
        return path

    def next_step(self, current: str, target: str) -> str | None:
        path = self.shortest_path(current, target)
        return path[1] if path and len(path) > 1 else None

    def suggest(self, difficulty: str, rng: random.Random | None = None) -> Puzzle:
        """A start and end word whose par falls in the difficulty's range and can be
        reached in par moves using familiar words only."""
        rng = rng or random
        lo, hi = PAR_RANGES[self.length][difficulty]
        endpoints = [w for w in self.common if _good_endpoint(w) and self.neighbours[w]]
        for _ in range(300):
            start = rng.choice(endpoints)
            full = self.distances_from(start)
            known = self.distances_from(start, known_only=True)
            options = [w for w in endpoints if lo <= known.get(w, -1) <= hi and known[w] == full[w]]
            if options:
                end = rng.choice(options)
                return Puzzle(start, end, full[end])
        raise RuntimeError(f"No {self.length}-letter {difficulty} puzzle found")


def _good_endpoint(word: str) -> bool:
    # Plurals and verb forms make dull start/end words ("cats", "ended").
    return not (word.endswith("s") and not word.endswith("ss")) and not word.endswith("ed")


@lru_cache(maxsize=1024)
def _distances(graph: WordGraph, source: str, known_only: bool) -> dict[str, int]:
    dist = {source: 0}
    queue = deque([source])
    while queue:
        w = queue.popleft()
        for n in graph.neighbours[w]:
            if n not in dist and (not known_only or n in graph.known):
                dist[n] = dist[w] + 1
                queue.append(n)
    return dist


def differs_by_one(a: str, b: str) -> bool:
    return len(a) == len(b) and sum(x != y for x, y in zip(a, b)) == 1


def changed_position(a: str, b: str) -> int:
    return next(i for i, (x, y) in enumerate(zip(a, b)) if x != y)


def _read(name: str) -> list[str]:
    return (DATA_DIR / name).read_text().split()


@lru_cache(maxsize=None)
def graph(length: int) -> WordGraph:
    if length not in LENGTHS:
        raise ValueError(f"Word length must be one of {LENGTHS}")
    return WordGraph(
        length,
        _read(f"valid_{length}.txt"),
        _read(f"known_{length}.txt"),
        _read(f"common_{length}.txt"),
    )
