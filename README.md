# Word Ladder

Change one letter at a time to turn the start word into the end word. Play solo, or team up
online with a friend: you add a word, they add the next, and you climb the ladder together.

- 4, 5 or 6 letter words, with easy, medium and hard puzzles suggested by the game, or your own start and end words
- Online co-op by invite link, live when you're both in the game, turn by turn when you're not
- "Your turn" notifications on your phone, plus a reminder if a turn waits 24 hours
- Installable to the home screen (PWA)

**Live:** https://wordladder-ys5c.onrender.com

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
| `src/wordladder/push.py` | Phone notifications (Web Push) and 24-hour turn reminders |
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

### Notifications

The server signs notifications with its own key pair (VAPID). Locally the private key is created on
first run in `.vapid_private.pem`, which is git-ignored. Keep it secret: anyone with it can send
notifications as your app.

Notifications are always on; there's no setting. Browsers require one permission popup, which the
app shows on the player's first tap (usually when they enter their name). A player is only notified
when they don't have that game open; if they do, the move shows up live.
They're sent when a friend joins, when it becomes your turn, when the ladder is finished or given up,
when your friend starts a new ladder, and once if a turn has waited 24 hours.

On iPhone, notifications only work after adding Word Ladder to the Home Screen (iOS 16.4+), and
need the site on HTTPS. On Android and desktop Chrome they work in the browser too.

### Settings (environment variables)

| Variable | Default | Use |
| --- | --- | --- |
| `DATABASE_URL` or `WORDLADDER_DB` | `sqlite:///./wordladder.db` | Database URL. `postgres://` URLs work as-is |
| `WORDLADDER_VAPID_PRIVATE_KEY` | from `.vapid_private.pem` | Any long random secret; the notification key pair is derived from it |
| `WORDLADDER_VAPID_SUBJECT` | `RENDER_EXTERNAL_URL`, else `https://localhost` | The site's address. Apple requires a real one |

## Deploy

The app runs on [Render](https://render.com)'s free plan, with the database on
[Neon](https://neon.tech)'s free plan. Render's own free Postgres is deleted after 30 days, so it's
not used. `render.yaml` describes the service.

1. **Database (Neon):** create a project in the AWS Singapore region and copy its connection
   string (`postgresql://...`).
2. **App (Render):** New > Web Service from this repo, Python 3, region Singapore, Free instance,
   with the build and start commands from `render.yaml`, health check path `/healthz`, and these
   environment variables: `PYTHON_VERSION=3.12.14`, `DATABASE_URL` (the Neon string), and
   `WORDLADDER_VAPID_PRIVATE_KEY` (from `openssl rand -base64 32`; never change it, or existing
   notification subscriptions stop working). Every push to `main` redeploys.
   (New > Blueprint reads `render.yaml` directly, but Render asks for a card on file for Blueprints.)

On the free plan the app sleeps after 15 minutes without visitors, so the first visit after that
takes about a minute. Turn reminders are checked whenever it's awake.

To test the production setup locally against Postgres, run the tests with
`TEST_DB=postgresql://user@localhost:5432/dbname uv run pytest`.
