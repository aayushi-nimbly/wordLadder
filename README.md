# Word Ladder

Change one letter at a time to turn the start word into the end word. Play solo, or team up
online with a friend: you add a word, they add the next, and you climb the ladder together.

- 4, 5 or 6 letter words, with easy, medium and hard puzzles suggested by the game, or your own start and end words
- Online co-op by invite link, live when you're both in the game, turn by turn when you're not
- Installable to the home screen (PWA)

The design plan and screen mockups are in [`docs/plan.html`](docs/plan.html).

## Run it locally

Requires [uv](https://docs.astral.sh/uv/).

```sh
uv sync
uv run uvicorn wordladder.main:app --reload --port 8000
```

Open http://localhost:8000. To try two-player on one computer, use a normal window and a private
window (each one is a separate guest player).

To play from your phone on the same Wi-Fi, run with `--host 0.0.0.0` and open
`http://<your-mac's-ip>:8000`. Installing to the home screen needs HTTPS, which you get once it's
deployed.

## Tests

```sh
uv run pytest
```

## How it fits together

| Path | What it does |
| --- | --- |
| `src/wordladder/engine.py` | Word lists, the one-letter-apart graph, shortest paths, puzzle suggestions |
| `src/wordladder/rules.py` | Creating and joining games, moves, undo, hints, team stars |
| `src/wordladder/db.py` | Tables (SQLite locally, Postgres via `WORDLADDER_DB` in production) |
| `src/wordladder/realtime.py` | WebSocket rooms that push fresh game state to both players |
| `src/wordladder/main.py` | FastAPI routes and serving the web app |
| `src/wordladder/static/` | The web app: `app.js`, `styles.css`, service worker, manifest, icons |
| `scripts/build_wordlists.py` | Regenerates `data/*.txt` from the ENABLE word list + word frequencies |
| `scripts/make_icons.py` | Redraws the app icons |

### Word lists

Three tiers per word length, in `src/wordladder/data/`:

- **valid**: every word in the public-domain ENABLE list. Any of these is accepted as a move.
- **known**: valid words most people recognise. Suggested puzzles always have a shortest ladder
  made only of these, and hints use them.
- **common**: everyday words. Only these are suggested as start and end words.

To rebuild them, download `enable1.txt` and run
`uv run python scripts/build_wordlists.py path/to/enable1.txt`.

## Still to do

- "Your turn" push notifications and reminders
- Deploy (Render or Fly.io + Postgres) so friends can reach it and it can be installed
