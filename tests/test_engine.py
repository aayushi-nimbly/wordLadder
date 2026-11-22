import random

import pytest

from wordladder import engine


@pytest.fixture(scope="module")
def g4():
    return engine.graph(4)


def test_neighbours_differ_by_one_letter(g4):
    assert "cord" in g4.neighbours["cold"]
    assert all(engine.differs_by_one("cold", n) for n in g4.neighbours["cold"])
    assert "cold" not in g4.neighbours["cold"]


def test_distance_and_path(g4):
    assert g4.distance("cold", "warm") == 4
    path = g4.shortest_path("cold", "warm")
    assert path[0] == "cold" and path[-1] == "warm" and len(path) == 5
    assert all(engine.differs_by_one(a, b) for a, b in zip(path, path[1:]))
    assert all(g4.is_word(w) for w in path)


def test_path_to_self_and_unreachable(g4):
    assert g4.shortest_path("cold", "cold") == ["cold"]
    assert g4.next_step("cold", "cold") is None
    lonely = next(w for w, ns in g4.neighbours.items() if not ns)
    assert g4.shortest_path(lonely, "cold") is None
    assert g4.distance(lonely, "cold") is None


def test_next_step_moves_one_closer(g4):
    step = g4.next_step("cold", "warm")
    assert g4.distance(step, "warm") == 3


@pytest.mark.parametrize("length", engine.LENGTHS)
@pytest.mark.parametrize("difficulty", engine.DIFFICULTIES)
def test_suggest_respects_par_range(length, difficulty):
    g = engine.graph(length)
    rng = random.Random(length * 31 + len(difficulty))
    lo, hi = engine.PAR_RANGES[length][difficulty]
    for _ in range(5):
        p = g.suggest(difficulty, rng)
        assert len(p.start) == len(p.end) == length
        assert p.start in g.common and p.end in g.common
        assert lo <= p.par <= hi
        assert g.distance(p.start, p.end) == p.par
        path = g.shortest_path(p.start, p.end)
        assert len(path) == p.par + 1
        assert all(w in g.known for w in path)


def test_changed_position():
    assert engine.changed_position("cold", "cord") == 2


def test_unknown_length():
    with pytest.raises(ValueError):
        engine.graph(7)
