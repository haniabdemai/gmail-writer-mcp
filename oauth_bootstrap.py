#!/usr/bin/env python3
"""One-off OAuth bootstrap for the gmail-writer MCP server.

Runs Google's installed-app flow with the gmail.modify scope and writes
~/.gmail_token.json in exactly the shape index.js and test.js expect
(client_id, client_secret, token, refresh_token, expiry, scopes),
with permissions restricted to the owner (chmod 600).

Run:
  uv run --with google-auth-oauthlib oauth_bootstrap.py client_secret.json
or:
  pip install google-auth-oauthlib
  python3 oauth_bootstrap.py client_secret.json
"""
import json
import os
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
TOKEN_PATH = Path.home() / ".gmail_token.json"


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: oauth_bootstrap.py <path/to/client_secret.json>")
    flow = InstalledAppFlow.from_client_secrets_file(sys.argv[1], SCOPES)
    creds = flow.run_local_server(port=0)
    data = {
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        # google-auth returns a naive UTC datetime; mark it as UTC for JS.
        "expiry": creds.expiry.isoformat() + "Z" if creds.expiry else None,
        "scopes": list(creds.scopes or SCOPES),
    }
    TOKEN_PATH.write_text(json.dumps(data, indent=2))
    os.chmod(TOKEN_PATH, 0o600)
    print(f"Wrote {TOKEN_PATH} (chmod 600). Scopes: {', '.join(data['scopes'])}")


if __name__ == "__main__":
    main()
