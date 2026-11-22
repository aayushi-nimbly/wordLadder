"""Build the word lists the game ships with.

Usage:
    uv run python scripts/build_wordlists.py path/to/enable1.txt

Writes src/wordladder/data/{valid,known,common}_{n}.txt for n in 4, 5, 6.

- valid:  every ENABLE word of that length. Used to accept moves.
- known:  valid words most people would recognise. Suggested puzzles must have
          a shortest ladder made only of these, and hints use them.
- common: valid words that are frequent in everyday English (wordfreq).
          Used only for suggested start and end words.
"""

import sys
from pathlib import Path

from wordfreq import zipf_frequency

LENGTHS = (4, 5, 6)
COMMON_MIN_ZIPF = 3.4  # roughly "seen a few times per million words"
KNOWN_MIN_ZIPF = 2.5
DATA_DIR = Path(__file__).resolve().parent.parent / "src" / "wordladder" / "data"

# Words never suggested and never accepted.
BLOCKLIST = {
    "cunt", "dick", "fuck", "shit", "piss", "twat", "slut", "whore", "fags", "faggot",
    "nigga", "nigger", "kike", "spic", "chink", "gook", "dyke", "wank", "cock", "cocks",
    "bitch", "prick", "rape", "raped", "rapes", "rapist", "porn", "pussy", "boner",
    "fucks", "shits", "dicks", "cunts", "sluts", "twats", "titty", "tits", "anal",
    "nazi", "nazis",
}


def main(enable_path: str) -> None:
    words = {
        w.strip().lower()
        for w in Path(enable_path).read_text().splitlines()
        if w.strip().isalpha()
    }
    words -= BLOCKLIST
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for n in LENGTHS:
        valid = sorted(w for w in words if len(w) == n)
        freq = {w: zipf_frequency(w, "en") for w in valid}
        known = [w for w in valid if freq[w] >= KNOWN_MIN_ZIPF]
        common = [w for w in valid if freq[w] >= COMMON_MIN_ZIPF]
        for name, words_ in (("valid", valid), ("known", known), ("common", common)):
            (DATA_DIR / f"{name}_{n}.txt").write_text("\n".join(words_) + "\n")
        print(f"{n} letters: {len(valid):>6} valid, {len(known):>5} known, {len(common):>5} common")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
