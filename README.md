# gmail-writer-mcp

**A local MCP server that gives Claude working Gmail write operations:
because the hosted Gmail MCP's write tools are broken by design.**

## The bug this fixes

The claude.ai hosted Gmail MCP *shows* write tools (`label_thread`,
`unlabel_thread`, …) but every call fails with "insufficient
authentication scopes". Root cause, found the hard way: the hosted MCP has
a tool cap during OAuth negotiation, and under it it only requests
`gmail.readonly`: never `gmail.modify`. The write tools are advertised
but can never work. This server sidesteps the whole path: a local MCP
process with its own Desktop OAuth client requesting the correct scope.

## Tools

| Tool | Description |
|---|---|
| `gmail_modify_thread` | Add/remove labels on a thread: move, archive, star, mark read/unread |
| `gmail_search_threads` | Search threads with Gmail query syntax |
| `gmail_list_labels` | List all labels with IDs |
| `gmail_list_attachments` | Find attachments across messages matching a query (metadata only) |
| `gmail_download_attachment` | Download one attachment by ID |
| `gmail_download_all_attachments` | Bulk-download every attachment matching a query, foldered per email |

Also included: `label-for-deletion.mjs`, a standalone script that applies a
review label to inbox junk matching your queries (edit the `QUERIES` array;
set `GMAIL_DELETION_LABEL_ID`) so you bulk-delete from the Gmail UI with
one filtered view.

## Setup

Requires Node 18+.

1. In Google Cloud Console: create a project, enable the Gmail API, create
   a **Desktop app** OAuth client, and download its `client_secret.json`.
   Note: while the OAuth consent screen is in "Testing" status, Google
   expires refresh tokens after 7 days. Add yourself as a test user or
   publish the app to avoid weekly re-authentication.
2. Run the bundled bootstrap to authorise and write `~/.gmail_token.json`
   (scope `https://www.googleapis.com/auth/gmail.modify`, chmod 600):

```bash
uv run --with google-auth-oauthlib oauth_bootstrap.py client_secret.json
# or: pip install google-auth-oauthlib && python3 oauth_bootstrap.py client_secret.json
```

   The resulting file has the shape
   `{client_id, client_secret, token, refresh_token, expiry, scopes}`: it
   is self-contained and the server refreshes it automatically.
3. `npm install`, then register with Claude Code:

```bash
claude mcp add gmail-writer -- node /path/to/gmail-writer-mcp/index.js
```

4. `node test.js` runs the non-destructive test suite against your mailbox.

## Usage

The attachment tools chain naturally. For example, ask Claude:

> Find every invoice PDF from 2026 and save them foldered per email.

and it will use `gmail_list_attachments` plus `gmail_download_all_attachments`
to land the files under `~/Downloads/gmail-attachments/`, one folder per email.

## Security notes

- The token file grants mail write access: keep it out of any repo
  (`chmod 600`, never commit). The bootstrap and the server both write it
  with owner-only permissions, and the server warns at startup if it is
  readable by anyone else.
- This server cannot send email. There is no send or draft capability, by
  design, so a misbehaving session cannot write to anyone on your behalf.
- The `gmail.modify` scope does include trashing (adding the TRASH or SPAM
  label), which effectively deletes mail. Rely on your client's
  tool-approval prompt before approving modify calls.
- `outputDir` on the attachment download tools is model-controlled: review
  tool calls before approving so downloads land where you expect.
- The server runs locally and talks only to Google's API; nothing is
  proxied through third parties.

Built on the official MCP TypeScript SDK and googleapis.

## Licence

MIT.
