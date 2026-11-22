"""Sign in with Google (OAuth 2.0 authorization code flow with PKCE).

Settings:
  GOOGLE_CLIENT_ID      public id of the OAuth client (has a default for this app)
  GOOGLE_CLIENT_SECRET  secret of the OAuth client; set it in Render, never commit it.
                        Locally it can also come from the client JSON Google lets you download
                        (client_secret_....json) saved in the project folder; it's git-ignored.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx

CLIENT_ID = os.environ.get(
    "GOOGLE_CLIENT_ID", "799520451715-l96488ll6sbv7ekj328o21mqe79koqdc.apps.googleusercontent.com"
)
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
ISSUERS = {"accounts.google.com", "https://accounts.google.com"}


class GoogleError(Exception):
    pass


def client_secret() -> str | None:
    secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    if secret:
        return secret
    # The JSON Google lets you download (client_secret_....json), saved in the project folder.
    named = os.environ.get("GOOGLE_CLIENT_FILE")
    candidates = [Path(named)] if named else [Path("google_client.json"), *sorted(Path(".").glob("client_secret*.json"))]
    for path in candidates:
        if path.exists():
            data = json.loads(path.read_text())
            return (data.get("web") or data.get("installed") or {}).get("client_secret")
    return None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def start(redirect_uri: str) -> tuple[str, str, str]:
    """Returns (url to send the browser to, state, code verifier). Keep state and verifier until the
    callback."""
    state = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    url = AUTH_URL + "?" + urlencode({
        "client_id": CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    })
    return url, state, verifier


def finish(code: str, verifier: str, redirect_uri: str) -> dict:
    """Swaps the code from Google's redirect for the signed-in person's details:
    {"sub": Google account id, "email": ..., "name": ..., "given_name": ...}."""
    secret = client_secret()
    if not secret:
        raise GoogleError("Google sign-in isn't set up on this server (GOOGLE_CLIENT_SECRET is missing).")
    try:
        r = httpx.post(TOKEN_URL, data={
            "code": code, "client_id": CLIENT_ID, "client_secret": secret, "redirect_uri": redirect_uri,
            "grant_type": "authorization_code", "code_verifier": verifier,
        }, timeout=15)
    except httpx.HTTPError as e:
        raise GoogleError(f"Couldn't reach Google: {e}") from e
    if r.status_code != 200:
        raise GoogleError(f"Google refused the sign-in ({r.status_code}): {r.text[:200]}")
    return read_id_token(r.json().get("id_token", ""))


def read_id_token(id_token: str) -> dict:
    """The ID token came straight from Google's token endpoint over HTTPS, so (per OpenID Connect)
    its signature doesn't need re-checking; its audience, issuer and expiry still do."""
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError) as e:
        raise GoogleError("Google sent an unreadable sign-in token.") from e
    if claims.get("aud") != CLIENT_ID or claims.get("iss") not in ISSUERS:
        raise GoogleError("That sign-in token wasn't meant for this app.")
    if claims.get("exp", 0) < time.time():
        raise GoogleError("The sign-in took too long. Try again.")
    if not claims.get("sub"):
        raise GoogleError("Google didn't say who signed in.")
    return claims
