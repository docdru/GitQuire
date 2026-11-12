# Deploying GitQuire

GitQuire ships as one Docker image, `ghcr.io/docdru/gitquire`, with all state in a `/data` volume.
This page covers running it, GitHub sign-in, repository sync, email and chat notifications, and AI
agent access. For what GitQuire does, see the [README](./README.md).

- [Quick start](#quick-start)
- [GitHub sign-in](#github-sign-in)
- [Sync a GitHub repository](#sync-a-github-repository)
- [Branches and pull requests](#branches-and-pull-requests)
- [Mention emails](#mention-emails)
- [Chat notifications](#chat-notifications)
- [AI agents](#ai-agents)
- [Other settings](#other-settings)
- [Build the image yourself](#build-the-image-yourself)
- [Environment variable reference](#environment-variable-reference)

## Quick start

```bash
docker run --rm -p 8080:8080 \
  -e OK_ALLOW_EXTERNAL=1 \
  -v gitquire-data:/data \
  ghcr.io/docdru/gitquire:latest
# then open http://localhost:8080
```

> **Warning:** without GitHub sign-in (below), anyone who can reach the port can read and edit
> everything. Turn sign-in on before exposing GitQuire beyond localhost.

Behind a real domain, also set `OK_EXTERNAL_URL=https://your.domain`. Run exactly one container per
volume: the collaboration server is single-writer. Health checks: `GET /healthz` and `GET /readyz`.

For nginx, start from [`deploy/nginx/sites-available/gitquire.conf`](./deploy/nginx/sites-available/gitquire.conf).
It forwards WebSocket upgrades (live editing needs them) and allows uploads up to 50 MB. Publish the
container port on loopback only (`-p 127.0.0.1:8080:8080`) so nginx is the only way in, and set
`OK_EXTERNAL_URL` to the address people open: `http://` until certbot has added HTTPS, then
`https://` (restart the container after changing it).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `OK_BIND` | `0.0.0.0` | Bind address |
| `OK_ALLOW_EXTERNAL` | unset | Must be `1` to accept non-local connections |
| `OK_EXTERNAL_URL` | unset | Public origin, required behind a domain or proxy |
| `GITQUIRE_GIT_NAME`, `GITQUIRE_GIT_EMAIL` | `GitQuire`, `gitquire@localhost` | Git identity for commits not made by a signed-in person |

## GitHub sign-in

With sign-in on, every page, API call and live-editing connection needs a GitHub session.
People with write access to `GITQUIRE_REPO` (or listed in `GITQUIRE_ALLOWED_USERS`) can sign in.

1. Create a GitHub App (GitHub → Settings → Developer settings → GitHub Apps → New):
   - **Callback URL:** `https://brain.example.com/auth/github/callback` (your `OK_EXTERNAL_URL`
     plus `/auth/github/callback`). Add `http://localhost:8080/auth/github/callback` too for local use.
   - **Repository permissions:** Contents read and write, Pull requests read and write,
     Metadata read.
   - Uncheck **Webhook → Active**.
2. Install the app on the content repository.
3. Generate a client secret, then run:

```bash
docker run -d --name gitquire -p 8080:8080 \
  -e OK_ALLOW_EXTERNAL=1 \
  -e OK_EXTERNAL_URL=https://brain.example.com \
  -e GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxx \
  -e GITHUB_APP_CLIENT_SECRET=xxxxxxxx \
  -e GITQUIRE_SESSION_SECRET="$(openssl rand -hex 32)" \
  -e GITQUIRE_REPO=acme/team-notes \
  -v gitquire-data:/data \
  ghcr.io/docdru/gitquire:latest
```

| Variable | Meaning |
| --- | --- |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | From the GitHub App. Setting the client ID turns sign-in on. |
| `GITQUIRE_SESSION_SECRET` | At least 32 random characters; signs the session cookie. |
| `GITQUIRE_REPO` | `owner/name`. Anyone with write access to it may sign in. |
| `GITQUIRE_ALLOWED_USERS` | Optional comma-separated GitHub logins allowed in addition (or instead). |
| `GITQUIRE_ADMINS` | Optional logins allowed to use server administration routes. |
| `GITQUIRE_SESSION_DAYS` | Session length, default 7. |
| `GITQUIRE_AUTH` | `off` disables sign-in even when a client ID is set. |

Sign out at `/auth/logout` (a page with a sign-out button; the session is cleared by its POST).
`/auth/me` returns the signed-in user as JSON.

## Sync a GitHub repository

With a GitHub App configured, the container clones `GITQUIRE_REPO` into `/data` on first start and
pushes edits back automatically (pull every 30 s, push every 60 s). Git authenticates with a
short-lived installation token (scoped to that one repository) that GitQuire mints and refreshes
itself. No personal token is used, and the token is never persisted: it is passed to each `git`
call through its environment, so don't share the container's process namespace with untrusted
containers. GitHub.com is the supported host.

Use the same GitHub App as for sign-in: note its **App ID**, generate a **private key** (`.pem`),
and make sure it is installed on the repository with **Contents: read and write**. Then add:

```bash
  -e GITHUB_APP_ID=123456 \
  -e GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/gitquire-app.pem \
  -v /path/on/host/gitquire-app.pem:/run/secrets/gitquire-app.pem:ro \
```

| Variable | Meaning |
| --- | --- |
| `GITHUB_APP_ID` | Turns repository sync on. |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Path to the app's private key inside the container (or put the PEM in `GITHUB_APP_PRIVATE_KEY`). |
| `GITQUIRE_REPO` | The repository to sync, `owner/name`. |
| `GITQUIRE_BRANCH` | Branch to edit; defaults to the repository's default branch. |
| `GITQUIRE_SYNC_MODE` | `full` (pull and push, default), `follow` (pull only) or `off`. Applied on first start; later changes are made in the app. |

If GitHub is unreachable at start, GitQuire retries for about five minutes before giving up
(exit code 75, so a restart policy can try again); configuration problems stop it immediately
(exit code 78). The volume keeps the checkout between restarts. On an empty repository, GitQuire
starts the branch and pushes the first commit. Commits are authored by the people who made the
edits; changes without a signed-in person are authored as `GITQUIRE_GIT_NAME` /
`GITQUIRE_GIT_EMAIL`.

## Branches and pull requests

Everyone edits one working copy, so the branch is shared: switching it moves every open editor to
that branch. Pull requests are opened by the GitHub App, with the proposer's GitHub login in the
description, so the app needs **Pull requests: read and write**. Any signed-in member may switch or
create branches.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/gitquire/branches` | Current, base, local and remote-only branches. |
| `POST /api/gitquire/branches` | Create a branch: `{"name": "report/q4", "from": "main"}` (`from` defaults to the current state). |
| `POST /api/git/checkout` | Switch the shared working copy to another branch. |
| `GET /api/gitquire/pulls` | Open pull requests on the repository. |
| `POST /api/gitquire/pulls` | Open a pull request from the current branch: `{"title": "…", "body": "…", "draft": false}`. |

## Mention emails

People enter their address under the mention list and get a confirmation mail with a code; email
starts once they enter the code in GitQuire. Codes are valid for 24 hours and allow five tries. A
new code can be requested after a minute; at most five confirmation mails go out per person and
three per address a day, and 30 an hour for the whole server. Once a minute, new mentions they have
not read yet are mailed; mentions that already existed when the address was confirmed are not.

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_SMTP_URL` | `smtps://user:password@host:465` or `smtp://user:password@host:587`. Without it, email is off. |
| `GITQUIRE_MAIL_FROM` | Sender address. Required; without a valid one, email stays off and a warning is logged. |
| `GITQUIRE_MAIL_DOMAINS` | Optional comma-separated domains people may enter, for example `acme.com`. Without it, any address is accepted. |

With `smtp://`, STARTTLS is required; add `?starttls=off` only for a local relay, and a password is
then only sent to `localhost`. Mail is limited to 20 per person per day and 100 per hour in total;
the counts start over when the server restarts. People who have not opened GitQuire for 30 days get
no mail. The link in the mail is built from `OK_EXTERNAL_URL`; without it, the mail has no link.

Read state and email settings are kept on the server in `/data/.ok/local/gitquire/mentions.json`,
outside Git.

## Chat notifications

Set `GITQUIRE_CHAT_WEBHOOK_URL` to an incoming webhook of Slack, Microsoft Teams (Workflows),
Discord, Mattermost or Rocket.Chat; other services get plain JSON. The format is guessed from the
URL, or set `GITQUIRE_CHAT_FORMAT` to `slack`, `teams`, `discord` or `generic`. Mentions that exist
when the webhook is first set up are not posted.

## AI agents

Each person connects their own AI agent, with their own Claude (or other) account. Nothing runs on
the server on their behalf.

1. Sign in and open `/auth/agents` (also linked from `/auth/logout`).
2. Create a token. The page shows it once, with the command for Claude Code and the config for the
   Claude desktop app:

   ```bash
   claude mcp add --transport http gitquire https://wiki.example.com/mcp \
     --header "Authorization: Bearer gqa_…"
   ```

3. Ask the agent to work on the wiki. Its edits show up live and are committed with you as the
   author.

### Claude on the web and on phones

With `GITQUIRE_MCP_CONNECTORS=on`, `/mcp` also speaks the sign-in protocol that cloud connectors
use (OAuth 2.1 with PKCE, client metadata documents and dynamic registration). In Claude's
settings, add a custom connector with the address `https://wiki.example.com/mcp`. A popup opens,
you sign in with GitHub and approve, and Claude can then work on the wiki from any device, as you.

The connection comes from Anthropic's servers, so the wiki must be reachable on the public
internet over HTTPS. GitHub sign-in and the repository's write access still decide who gets in.
Each connected app shows up on `/auth/agents`, where it can be revoked. Its access token lasts an
hour and is renewed with a refresh token for up to 90 days of inactivity.

### Token storage

Tokens are stored hashed in `.ok/local/gitquire/agent-tokens.json` on the data volume, never in
the repository. Revoke one from `/auth/agents`; admins (`GITQUIRE_ADMINS`) can revoke anyone's.
Every ten minutes the server checks that token owners can still write to `GITQUIRE_REPO` (using
the GitHub App when it is configured) and revokes the tokens of people who lost access.

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_AGENT_TOKEN_DAYS` | How long a personal agent token stays valid, default 90. |
| `GITQUIRE_MCP_CONNECTORS` | `on` lets Claude on the web, desktop chat and phones connect through GitHub sign-in. Needs a public `https://` URL. |
| `GITQUIRE_MCP_TOKEN` | Optional shared token for `/mcp`. Prefer personal agent tokens: edits made with the shared token are not credited to anyone. |
| `GITQUIRE_ASK_AI` | `on` shows the editor's **Ask AI** box and the empty screen's prompt box. Off by default, because they hand work to an agent running on the server, which a shared team server doesn't have. While it is off, people with agent access get the **Ask Claude** box instead. |

## Other settings

| Setting | Meaning |
| --- | --- |
| `GITQUIRE_NAMING=off` | Keep page and folder names exactly as typed instead of lowercase-hyphenated. |
| `validation.links: off` | Hide the broken-links button in the header. |

## Build the image yourself

```bash
docker build -t gitquire:local .
```

CI builds and smoke-tests the image on every pull request and publishes it to
`ghcr.io/docdru/gitquire` from `main` (see [`.github/workflows/docker.yml`](./.github/workflows/docker.yml)).

## Environment variable reference

| Variable | Section |
| --- | --- |
| `PORT`, `OK_BIND`, `OK_ALLOW_EXTERNAL`, `OK_EXTERNAL_URL` | [Quick start](#quick-start) |
| `GITQUIRE_GIT_NAME`, `GITQUIRE_GIT_EMAIL` | [Quick start](#quick-start) |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITQUIRE_SESSION_SECRET` | [GitHub sign-in](#github-sign-in) |
| `GITQUIRE_REPO`, `GITQUIRE_ALLOWED_USERS`, `GITQUIRE_ADMINS`, `GITQUIRE_SESSION_DAYS`, `GITQUIRE_AUTH` | [GitHub sign-in](#github-sign-in) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_APP_PRIVATE_KEY` | [Sync a GitHub repository](#sync-a-github-repository) |
| `GITQUIRE_BRANCH`, `GITQUIRE_SYNC_MODE` | [Sync a GitHub repository](#sync-a-github-repository) |
| `GITQUIRE_SMTP_URL`, `GITQUIRE_MAIL_FROM`, `GITQUIRE_MAIL_DOMAINS` | [Mention emails](#mention-emails) |
| `GITQUIRE_CHAT_WEBHOOK_URL`, `GITQUIRE_CHAT_FORMAT` | [Chat notifications](#chat-notifications) |
| `GITQUIRE_AGENT_TOKEN_DAYS`, `GITQUIRE_MCP_CONNECTORS`, `GITQUIRE_MCP_TOKEN`, `GITQUIRE_ASK_AI` | [AI agents](#ai-agents) |
| `GITQUIRE_NAMING` | [Other settings](#other-settings) |
