# Deploying GitQuire

GitQuire ships as one Docker image, `ghcr.io/docdru/gitquire`, with all state in a `/data` volume.
The image is the only supported way to run it: there is no install for running GitQuire directly on
macOS, Windows or a Linux host.
This page covers running it, GitHub sign-in, repository sync, email and chat notifications, and AI
agent access. For what GitQuire does, see the [README](./README.md).

- [Quick start](#quick-start)
- [GitHub sign-in](#github-sign-in)
- [Sync a GitHub repository](#sync-a-github-repository)
- [Drafts](#drafts)
- [Mention emails](#mention-emails)
- [Chat notifications](#chat-notifications)
- [AI agents](#ai-agents)
- [AI chat](#ai-chat)
- [Search by meaning](#search-by-meaning)
- [Wiki administration](#wiki-administration)
- [Build the image yourself](#build-the-image-yourself)
- [Environment variable reference](#environment-variable-reference)

## Quick start

```bash
docker run --rm -p 8080:8080 \
  -e GITQUIRE_ALLOW_EXTERNAL=1 \
  -v gitquire-data:/data \
  ghcr.io/docdru/gitquire:latest
# then open http://localhost:8080
```

> **Warning:** without GitHub sign-in (below), anyone who can reach the port can read and edit
> everything. Turn sign-in on before exposing GitQuire beyond localhost.

Behind a real domain, also set `GITQUIRE_EXTERNAL_URL=https://your.domain`. Run exactly one container per
volume: the collaboration server is single-writer. Health checks: `GET /healthz` and `GET /readyz`.

On `docker stop` GitQuire writes open pages to disk and waits for its draft editors to stop. Give it
time: `deploy/compose.yaml` sets `stop_grace_period: 60s`; with `docker run`, use `docker stop -t 60`. A
single-wiki server does not commit or push on stop; edits not pushed yet stay on the volume and are
pushed by the next sync after the restart.

For nginx, start from [`deploy/nginx/sites-available/gitquire.conf`](./deploy/nginx/sites-available/gitquire.conf).
It forwards WebSocket upgrades (live editing needs them) and allows uploads up to 50 MB. Publish the
container port on loopback only (`-p 127.0.0.1:8080:8080`) so nginx is the only way in, and set
`GITQUIRE_EXTERNAL_URL` to the address people open: `http://` until certbot has added HTTPS, then
`https://` (restart the container after changing it).

To keep these options in a file, use [`deploy/compose.yaml`](./deploy/compose.yaml). Put it in a
folder with `gitquire.env` (the variables from this page, one `NAME=value` per line) and, for
repository sync, the GitHub App key as `app.pem` with
`GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/app.pem`. Then:

| Task | Command |
| --- | --- |
| Start, or apply a changed `gitquire.env` | `docker compose up -d` |
| Update to the latest image | `docker compose pull && docker compose up -d` |
| Move to a released version | Set `image: ghcr.io/docdru/gitquire:<version>` in `compose.yaml`, then `docker compose pull && docker compose up -d` |
| Follow the log | `docker compose logs -f gitquire` |
| Start the Mailpit test inbox on port 8025 | `docker compose --profile mail-test up -d` |

If something else already uses port 8080 on the host, change only the left side of the mapping
(`127.0.0.1:8082:8080`) and point nginx's `proxy_pass` at that port. Mailpit is reachable from
GitQuire as `smtp://mailpit:1025?starttls=off`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `GITQUIRE_BIND` | `0.0.0.0` | Bind address |
| `GITQUIRE_ALLOW_EXTERNAL` | unset | Must be `1` to accept non-local connections |
| `GITQUIRE_EXTERNAL_URL` | unset | Public origin, required behind a domain or proxy |
| `GITQUIRE_GIT_NAME`, `GITQUIRE_GIT_EMAIL` | `GitQuire`, `gitquire@localhost` | Git identity for commits not made by a signed-in person |
| `GITQUIRE_AGENTS_FILE` | on | `off` stops GitQuire from writing its section of `AGENTS.md` (rules for AI agents) at the root of the wiki |

## GitHub sign-in

With sign-in on, every page, API call and live-editing connection needs a GitHub session.
People with write access to `GITQUIRE_REPO` (or listed in `GITQUIRE_ALLOWED_USERS`) can sign in.

1. Create a GitHub App (GitHub → Settings → Developer settings → GitHub Apps → New):
   - **Callback URL:** `https://brain.example.com/auth/github/callback` (your `GITQUIRE_EXTERNAL_URL`
     plus `/auth/github/callback`). Add `http://localhost:8080/auth/github/callback` too for local use.
   - **Repository permissions:** Contents read and write, Pull requests read and write,
     Metadata read. **Account permissions:** Email addresses read (for
     [mention emails](#mention-emails) to the account's address).
   - Uncheck **Webhook → Active**.
   - **Where can this GitHub App be installed?** Choose **Any account** if the app belongs to your
     personal account. A private app can only be authorized by its owner (or, for an app owned by
     an organization, by the organization's members); everyone else gets a 404 page from GitHub
     at sign-in. "Any account" lets others sign in and install the app on their own accounts, but
     GitQuire still opens only repositories they can write to, of the owners you allow. To change
     it later: the app's settings → Advanced → **Make public**.
2. Install the app on the content repository.
3. Generate a client secret, then run:

```bash
docker run -d --name gitquire -p 8080:8080 \
  -e GITQUIRE_ALLOW_EXTERNAL=1 \
  -e GITQUIRE_EXTERNAL_URL=https://brain.example.com \
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
| `GITQUIRE_ADMINS` | Optional comma-separated logins that may change wiki settings, in addition to the repository's admins and maintainers. See [Wiki administration](#wiki-administration). |
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
| `GITQUIRE_COMMIT_EMAIL_FORMAT` | Optional. The email address commits are authored with, built from `{login}` and `{id}` of the person's account. Default `{id}+{login}@users.noreply.github.com`, which GitHub links to the account; set it for GitHub Enterprise Server's no-reply domain. |

If GitHub is unreachable at start, GitQuire retries for about five minutes before giving up
(exit code 75, so a restart policy can try again); configuration problems stop it immediately
(exit code 78). The volume keeps the checkout between restarts. On an empty repository, GitQuire
starts the branch and pushes the first commit. Commits are authored by the people who made the
edits; changes without a signed-in person are authored as `GITQUIRE_GIT_NAME` /
`GITQUIRE_GIT_EMAIL`.

## Forgejo

GitQuire can use a [Forgejo](https://forgejo.org) server instead of GitHub: people sign in with
their Forgejo account, and a person may use the wiki when they can write to its repository, as on
GitHub. Forgejo 15 or later is required; Gitea and Codeberg may work but are not tested. A
single wiki uses one host; a front door for several wikis can serve GitHub and Forgejo together
(see [Two Git hosts on one server](#two-git-hosts-on-one-server)).

Forgejo has no GitHub App, so GitQuire acts through a **bot account** with **two tokens**:

| Token | Setting | Used for | Scopes |
| --- | --- | --- | --- |
| The bot's unlimited token | `GITQUIRE_HOST_TOKEN` | Asking Forgejo whether a person still has access (every ten minutes for AI agent tokens). Nothing else | `read:repository`, `read:user` |
| A token limited to the wiki's repository | `GITQUIRE_HOST_REPO_TOKEN` | Git (clone, pull, push) and drafts (branches and pull requests) | `write:repository`, limited to that one repository |

A token limited to one repository cannot ask about other people's access, which is why there are
two. Draft processes get only the limited token.

Set up once, as a Forgejo administrator or the repository's owner:

1. Create a user for GitQuire, for example `gitquire-bot`.
2. Add it to the wiki's repository as a collaborator with **Administrator** access. GitQuire
   checks this at start: with write access only, Forgejo refuses to tell GitQuire whether someone
   lost access, and GitQuire would never cut anyone off.
3. Sign in as the bot, open **Settings → Applications** and create the two tokens above. For the
   limited one choose **Specific repositories** and pick the wiki's repository. Forgejo creates
   tokens only for someone signed in as the bot, so GitQuire cannot make them itself.
4. Under **Settings → Applications → OAuth2 applications** (of any account, or site-wide as an
   administrator), create an application named GitQuire with the redirect URI
   `<GITQUIRE_EXTERNAL_URL>/auth/forgejo/callback`. GitQuire asks for `read:user read:repository`
   at sign-in, uses the token once to see who signed in and whether they may write, and does not
   keep it.

Then run the container with:

```bash
  -e GITQUIRE_HOST=forgejo \
  -e GITQUIRE_HOST_URL=https://git.example.org \
  -e GITQUIRE_HOST_CLIENT_ID=... -e GITQUIRE_HOST_CLIENT_SECRET=... \
  -e GITQUIRE_HOST_TOKEN_FILE=/run/secrets/forgejo-bot \
  -e GITQUIRE_HOST_REPO_TOKEN_FILE=/run/secrets/forgejo-wiki \
  -e GITQUIRE_REPO=team/wiki \
  -e GITQUIRE_SESSION_SECRET=... -e GITQUIRE_EXTERNAL_URL=https://wiki.example.org \
```

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_HOST` | `forgejo`. Unset or `github` for GitHub. |
| `GITQUIRE_HOST_URL` | The Forgejo server's public address, `https://` only (Git sends the token only over https), with a port if it is not 443. A server under a path (`https://example.org/git`) is not supported yet. |
| `GITQUIRE_HOST_API_URL` | Optional address for GitQuire's own API calls, for example over the Docker network (`http://forgejo:3000/api/v1`). Default `<GITQUIRE_HOST_URL>/api/v1`. |
| `GITQUIRE_HOST_CLIENT_ID`, `GITQUIRE_HOST_CLIENT_SECRET` | The OAuth2 application. Setting the client ID turns sign-in on. |
| `GITQUIRE_HOST_TOKEN` or `GITQUIRE_HOST_TOKEN_FILE` | The bot's unlimited token, for access checks. |
| `GITQUIRE_HOST_REPO_TOKEN` or `GITQUIRE_HOST_REPO_TOKEN_FILE` | The bot's token limited to `GITQUIRE_REPO`, for Git and drafts. Must differ from the unlimited one. |
| `GITQUIRE_COMMIT_EMAIL_FORMAT` | Default `{login}@noreply.<host name of GITQUIRE_HOST_URL>`, which matches Forgejo's default `NO_REPLY_ADDRESS`. Set it to `{login}@<your NO_REPLY_ADDRESS>` if yours differs, so Forgejo links commits to people. |

`GITQUIRE_REPO`, `GITQUIRE_BRANCH`, `GITQUIRE_SYNC_MODE`, `GITQUIRE_ADMINS` and
`GITQUIRE_ALLOWED_USERS` work as for GitHub. At start GitQuire checks the Forgejo version, that
the bot is an administrator of the repository, and that the limited token can write to it, and
stops with a message saying what to fix (exit code 78). If Forgejo is unreachable it retries for
about five minutes (exit code 75).

A data folder belongs to one host: GitQuire records `forgejo` in
`.gitquire/local/gitquire/host.json` on first start and refuses to start on a folder that GitHub
people already used, or with a different `GITQUIRE_HOST` later, because people's ids from two
hosts must not mix. Use a new volume when moving a wiki from GitHub to Forgejo.

If Forgejo uses a certificate from a private authority, mount the authority's certificate and set
`NODE_EXTRA_CA_CERTS` and `GIT_SSL_CAINFO` to its path.

## Drafts

People edit the live wiki, or a draft: their own copy that becomes live when someone publishes it
(see [Drafts](https://github.com/docdru/GitQuire/blob/main/docs/content/gitquire/drafts.mdx)). Drafts
need GitHub sign-in; with the GitHub App, each draft is a `draft/<name>` branch and a pull request,
so the App needs **Pull requests: read and write** and **Contents: read and write**. Without the App,
drafts use the repository's `origin` remote directly and are published by a squash merge.

For each draft in use, the server starts one more editor process, with its own working copy, and
forwards the people who opened that draft to it over a Unix socket in a private folder under `/tmp`. A process needs about 250 MB of
memory, starts in a few seconds, and stops after 30 minutes without anyone in the draft. Working
copies are kept in `GITQUIRE_DRAFTS_DIR` (default: `.gitquire-drafts/<folder>` next to the project,
so `/.gitquire-drafts/data` in the container). They can be recreated from GitHub, but mount a volume
there so edits that are less than a minute old survive a container restart; `deploy/compose.yaml`
does that.

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_DRAFTS_DIR` | Where draft working copies live. Must be outside the project folder. |

The old shared branch switch (`POST /api/git/checkout`) and the branch and pull request endpoints
(`/api/gitquire/branches`, `/api/gitquire/pulls`) still exist for scripts, but the editor no longer
offers them.

## Mention emails

In **Settings → Notifications** (the @ panel links there) each person chooses:

- **Email me mentions at <their account's address>:** one switch, off by default, no code. The
  address is the one the Git host reports as the account's primary, verified address, read at every
  sign-in (GitQuire keeps no token between sign-ins, so a change on the host takes effect at the
  next sign-in). No-reply addresses are skipped. If the host cannot be asked at a sign-in, the last
  verified address is kept for at most 30 days.
  - **GitHub:** the GitHub App needs the account permission **Email addresses: read** (GitHub App
    settings → Permissions → Account permissions). People approve it once at their next sign-in.
    Without it everything works, only the account address is not offered.
  - **Forgejo:** the `read:user` scope GitQuire already asks for is enough.
- **Use another address:** as before, with a confirmation mail and a code. Codes are valid for 24
  hours and allow five tries; a new code can be requested after a minute; at most five confirmation
  mails go out per person and three per address a day, 30 an hour and 100 a day for the whole server.

The setting belongs to the account, not to a wiki: the same in every wiki the person opens with that
account. A person with a GitHub and a Forgejo account has two settings; they are never matched, also
with the same address. Once a minute, new mentions the person has not read are mailed, only while
the person can still open that wiki; if the host cannot be asked, nothing is mailed and it is tried
again. Mentions that already existed when mail was switched on, or when a wiki was added later,
are not mailed. Each mail names the wiki and links into it. Behind the front door one mailer serves all wikis, and a sleeping wiki whose
branch moved on the host is started every 10 minutes so mentions pushed through Git are mailed too.

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_SMTP_URL` | `smtps://user:password@host:465` or `smtp://user:password@host:587`. Without it, email is off. |
| `GITQUIRE_MAIL_FROM` | Sender address. Required; without a valid one, email stays off and a warning is logged. |
| `GITQUIRE_MAIL_DOMAINS` | Optional comma-separated domains mail may go to, for example `acme.com`, for the account address and another address alike. Without it, any address is accepted. |

With `smtp://`, STARTTLS is required; add `?starttls=off` only for a local relay, and a password is
then only sent to `localhost`. Mail is limited to 20 per person per day, five per person a minute
and 100 per hour for the whole server; the counts start over when the server restarts, what was
mailed does not. People who have not opened GitQuire for 30 days get no mail. The link in the mail
is built from `GITQUIRE_EXTERNAL_URL`; without it, the mail has no link.

**Where it is kept:** behind the front door, per account in `/data/server/people/<host>-<account id>/`
(files readable only by the server's user): the mail setting and addresses, what was mailed per
wiki, personal settings, AI keys (sealed) and AI token counts. A single wiki keeps the same files in
`/data/.gitquire/local/gitquire/people/`. Read state stays per wiki in
`.gitquire/local/gitquire/mentions.json`. All of it is outside Git and addresses never reach Git,
the logs (only the login) or other people's answers.

**Upgrading:** at its first start with this version, GitQuire moves each wiki's per-wiki mail
address, personal settings, "Put my AI assistant's edits into a draft", AI keys and token counts
into these folders, once, and leaves the old files as they were. A confirmed address stays on; when
two wikis disagree, the most recently confirmed address, the most recently changed settings and the
most recently saved key win; codes waiting for confirmation are dropped. Going back to the previous
image finds the old files as they were at the move.

## People you can mention

Typing `@` in a comment or a page offers the people who use this wiki: everyone who has signed in,
the repository's collaborators with write access (read through the GitHub App, cached for ten
minutes; if GitHub refuses, only the other two sources are used) and `GITQUIRE_ALLOWED_USERS`. The
list of people who signed in is kept in `.gitquire/local/gitquire/people.json` on the data volume.

Action items that mention someone (`- [ ] … @alice`) notify them like comments do. When this
first runs, existing open action items are recorded as already seen, so nobody gets a burst of old
notifications.

## Chat notifications

Set `GITQUIRE_CHAT_WEBHOOK_URL` to an incoming webhook of Slack, Microsoft Teams (Workflows),
Discord, Mattermost or Rocket.Chat; other services get plain JSON. The format is guessed from the
URL, or set `GITQUIRE_CHAT_FORMAT` to `slack`, `teams`, `discord` or `generic`. Mentions that exist
when the webhook is first set up are not posted.

## AI agents

Each person connects their own AI agent, with their own Claude, Mistral (or other) account.
Nothing runs on the server on their behalf.

In the app, **Settings → Connect AI** walks people through it: with `GITQUIRE_MCP_CONNECTORS=on`
it shows the connector address and expandable steps for Claude (Customize → Connectors → Add
custom connector) and Mistral's Le Chat (Intelligence → Connectors → Custom MCP Connector), and it
links to the token page below for Claude Code. There, people can also choose to have their
assistant's edits go into a [draft](#drafts) instead of the live wiki; behind the front door this is
one choice for all wikis of the account.

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

### Mistral Le Chat

Le Chat connects the same way. An administrator of the Le Chat account (on the Free, Pro and Student
plans, the account owner) opens **Intelligence → Connectors**, clicks **+ Add Connector**, switches
to **Custom MCP Connector**, names it `gitquire` and enters `https://wiki.example.com/mcp`. Le Chat
registers itself with a client secret (`client_secret_basic`), which GitQuire issues at
registration and checks on every token request; the sign-in is then the same GitHub popup as for
Claude. Like Claude, Le Chat connects from Mistral's servers, so the wiki must be reachable on the
public internet over HTTPS.

### Token storage

Tokens are stored hashed in `.gitquire/local/gitquire/agent-tokens.json` on the data volume, never in
the repository. Revoke one from `/auth/agents`; admins (`GITQUIRE_ADMINS`) can revoke anyone's.
Every ten minutes the server checks that token owners can still write to `GITQUIRE_REPO` (using
the GitHub App when it is configured) and revokes the tokens of people who lost access.

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_AGENT_TOKEN_DAYS` | How long a personal agent token stays valid, default 90. |
| `GITQUIRE_MCP_CONNECTORS` | `on` lets Claude on the web, desktop chat and phones connect through GitHub sign-in. Needs a public `https://` URL. |
| `GITQUIRE_MCP_TOKEN` | Optional shared token for `/mcp`. Prefer personal agent tokens: edits made with the shared token are not credited to anyone. |

## AI chat

People can chat with Claude or Mistral in the ✨ pane (⌥⌘A) and from the box under each page. The
assistant searches, reads and, when asked, edits pages through the same tools as `/mcp`, so its
changes appear live, are credited to the person chatting, and follow their **Put my AI assistant's
edits into a draft** setting. It cannot delete pages, change settings, read hidden folders such as
`.gitquire` (where keys and chats are kept) or run commands. No `/mcp` client can read `.gitquire/local`
through `exec`; the server enforces that for connectors, agent tokens and the chat alike.

It is on whenever GitHub sign-in is on; the ✨ pane
shows the chat. Nothing runs until someone adds a key:

- **Each person uses their own API key** from the [Claude Console](https://platform.claude.com) or
  [Mistral La Plateforme](https://console.mistral.ai), entered under **Settings → AI chat**. GitQuire
  checks the key with the provider, then stores it encrypted (AES-256-GCM, key derived from
  `GITQUIRE_SESSION_SECRET`) with the person's other data (see [Mention emails](#mention-emails)): a
  key entered once works in every wiki of that account. Wiki processes get a key from the front door
  only while serving a request of its owner; it is never in an environment. It never sends a key
  anywhere but to its provider and never shows it again. Changing `GITQUIRE_SESSION_SECRET` makes
  saved keys unreadable; people then paste them again.
- **Spending is each person's responsibility.** They pay their provider per use and should set a
  monthly spending limit there; the settings page links to it. Each message is capped at 16,000
  output tokens (thinking included) and 12 tool steps, older tool results are shortened in long
  chats, and the chat shows the tokens a conversation has used.
- **Chats are kept per person** in `/data/.gitquire/local/gitquire/chats/<GitHub user id>/`, outside Git,
  and deleted 90 days after their last message. Only their owner sees them in the app; whoever runs
  the server can read the files. **Save as page** writes a chat into the wiki.
- **Token counts** per day and per chat are kept per person with the person's other data for the same
  90 days (also after a chat is deleted) and shown in **Settings → AI chat**: the totals of all wikis
  of the account, and the chats of the wiki it is opened in. Tokens only, no prices.
- Answers are **streamed** from the provider and passed on as they arrive. Behind nginx, the chat
  response already sends `X-Accel-Buffering: no`; a gateway set with the variables below may ignore
  streaming, which still works, only without the gradual display.
- The server calls `api.anthropic.com` and `api.mistral.ai` directly, so the container needs
  outbound HTTPS to them.

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_AI_CHAT` | `off` hides the AI chat for everyone. On by default. |
| `GITQUIRE_ANTHROPIC_BASE_URL`, `GITQUIRE_MISTRAL_BASE_URL` | Send provider calls through a gateway or proxy instead, e.g. `https://ai-gateway.example.com/anthropic`. |

## Search by meaning

The command palette (⌘K) and the MCP `search` tool find pages by their words. Search by meaning
adds a **By meaning** mode to the palette and lets agents find related pages that share no
keywords. It is off by default and set by the server, for everyone:

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_SEMANTIC_SEARCH` | `on` turns it on. |
| `GITQUIRE_EMBEDDINGS_API_KEY` | API key for the embeddings provider. Not needed for a provider on the same machine, such as Ollama on `localhost`. |
| `GITQUIRE_EMBEDDINGS_URL` | Base URL of an OpenAI-compatible embeddings API. Default `https://api.openai.com/v1`. |
| `GITQUIRE_EMBEDDINGS_MODEL` | Embeddings model. Default `text-embedding-3-small`. |

For example, with OpenAI:

```bash
GITQUIRE_SEMANTIC_SEARCH=on
GITQUIRE_EMBEDDINGS_API_KEY=sk-...
```

Know what you're choosing:

- **Page text leaves the server.** The wiki's pages, and every search typed in **By meaning**
  mode, are sent to the embeddings provider. Pages excluded by `.gitignore` or `.okignore` are
  never sent. Use a self-hosted provider such as Ollama if that matters to you.
- **One key, billed per use.** Pages are embedded the first time someone searches by meaning and
  again when they change. With OpenAI's small model, a typical team wiki costs cents.
- **Changing the URL or model re-embeds every page.** Vectors are cached on the data volume in
  `.gitquire/local/embeddings/`.

The key is only ever sent to `GITQUIRE_EMBEDDINGS_URL`. There is no Search page in the app's
settings: the environment is the only place to change this.

## Wiki administration

Settings under **User** in the app are personal: with GitHub sign-in on, each person's are saved
on the data volume in `.gitquire/local/gitquire/users/<GitHub user id>.yml`, outside Git.

Settings under **Wiki administration** apply to everyone: attachments, content rules, sync, link
previews, plugins, templates, skills and ignore patterns. Most are saved in the repository
(`.gitquire/config.yml`, `.okignore`, `.gitquire/templates/`); sync and link previews are saved on the data
volume in `.gitquire/local/config.yml`.

Wiki admins are the logins in `GITQUIRE_ADMINS` and everyone with the **Admin** or **Maintain**
role on `GITQUIRE_REPO`. Everyone else sees these pages greyed out and read-only, with a note
naming who to ask. The server enforces it: it refuses changes to the shared settings, the server
settings and the ignore patterns from anyone else. Each person can still show or hide hidden files
and folders in their own file tree.

GitHub roles are checked when someone signs in, so a person who just became a maintainer signs
out and in again. Templates and skills are files in the repository, so anyone who can push to it
can still change them there.

| Setting | Meaning |
| --- | --- |
| `GITQUIRE_NAMING=off` | Keep page and folder names exactly as typed instead of lowercase-hyphenated. |
| `validation.links: off` | Hide the broken-links button in the header. |

### Files changed directly on the server

GitQuire does not watch the content folder. Pages change through GitQuire: the editor, sync with
GitHub, drafts and AI agents. If you change files on the data volume yourself, for example with
`docker exec`, a `gitquire` command in the container or a backup restore, tell GitQuire to read
them again, or restart the container:

- in the app, under **Wiki administration** → **Sync & sharing**, choose **Re-read files**, or
- run `gitquire reread` inside the container.

Older versions watched the folder. `GITQUIRE_FILE_WATCHER_BACKEND` is now ignored; if your
`gitquire.env` still sets it, the log says so once at start and you can delete the line. Nothing else
changes when you upgrade.

## Behind GitQuire's front door

`GITQUIRE_BEHIND_FRONT_DOOR=1` is set by GitQuire itself for the editor process of each wiki once
several wikis run in one container (see [Several wikis](#several-wikis)). Do not set it on a
server people open directly: such a process answers only `/healthz` and `/readyz` to anyone else and
refuses every other request and websocket with 403.

With it on, the editor process:

- serves only requests that carry the internal secret (`GITQUIRE_INTERNAL_SECRET`, passed to it by
  the front door);
- takes the person from the front door (`x-gitquire-principal`, with the admin flag for this wiki)
  and never reads the session cookie; `/auth/me` answers for that person, every other `/auth/` route
  answers 404, and it sets no cookies;
- hands the open draft back in an `x-gitquire-view` response header instead of the `gq_view` cookie,
  and reads it from the same request header; the front door keeps the cookie at `/`;
- adds the address prefix the front door sends (`x-gitquire-prefix`, for example `/w/team/wiki`) to
  the live-editing address and its own redirects;
- has no agent tokens, no agent pages and no `/mcp` sign-in of its own;
- on `SIGTERM`, stops its drafts (which do the same), then commits and pushes what is not pushed
  yet (only with `autoSync.mode: full` and a remote), all within 50 seconds; the push gets at most
  15 seconds and only the time that is left, so a slow stop may leave edits unpushed on the volume.
  `GET /api/gitquire/stop-state` with the internal secret answers whether the wiki and its running
  drafts are pushed and clean (`{"pushedAndClean": true, …}`); the front door stops a wiki only then.

The front door sets `GITQUIRE_EXTERNAL_URL` of each editor process to the public address **with**
the wiki's prefix, for example `https://brain.example.com/w/team/wiki`, so links in mention mails and
chat messages open the right wiki. It also passes `GITQUIRE_REPO` (the wiki's `owner/name`),
`GITQUIRE_AI_CHAT` and `GITQUIRE_ADMINS`; behind the front door `GITQUIRE_ADMINS` only names the
admins in the settings hint, and who is an admin of this wiki comes from the forwarded person alone. It forwards the public `Host` and `X-Forwarded-Proto`, and sets
`GITQUIRE_ALLOW_EXTERNAL=1` for the process so those are admitted. It strips any `x-gitquire-*`
header that comes from a browser, and forwards a request with a person only after its own sign-in
check.

The editor process gets no host credentials of its own: no GitHub App key and no Forgejo bot
token. It asks the front door for a token limited to its own repository over a private socket
(`GITQUIRE_DOOR_TOKEN_SOCKET`, with its own internal secret) and asks again before that token runs
out.

## Several wikis

`GITQUIRE_WIKIS=on` turns the container into a front door for several wikis. Each wiki opens at
`/w/<host>/<owner>/<repo>/`, for example `/w/github/team/handbook/`, and runs in its own editor process, started when someone opens it and stopped
after 30 minutes without use, once it says it is pushed and clean. Try it on a copy of your volume first (see
[Moving a single wiki over](#moving-a-single-wiki-over)).

### Settings

| Setting | Meaning |
| --- | --- |
| `GITQUIRE_WIKIS=on` | Several wikis behind one front door. `off` or empty: one wiki, exactly as before. Any other value stops the container. |
| `GITQUIRE_ALLOWED_OWNERS` | Users or organisations on the host whose repositories may become wikis, separated by commas. Empty means the owner of `GITQUIRE_REPO`. With neither set, GitQuire does not start. |
| `GITQUIRE_REPO` | Optional. The repository whose single-wiki volume `gitquire wikis adopt` moves over; without `GITQUIRE_ALLOWED_OWNERS`, its owner is the allowed owner. |
| `GITQUIRE_ADMINS` | Server administrators. They see every disconnected wiki and why, can revoke anyone's agent tokens, and on Forgejo they are the only ones who add a wiki, because they enter its token. |

Needed as for one wiki: the sign-in settings of the host, `GITQUIRE_SESSION_SECRET` (at least 32
characters), optionally `GITQUIRE_SESSION_DAYS`, `GITQUIRE_EXTERNAL_URL` (the root address, without
a path), and GitQuire's own access: on GitHub `GITHUB_APP_ID` and the private key, on Forgejo
`GITQUIRE_HOST_TOKEN` (the bot's unlimited token). `GITQUIRE_HOST_REPO_TOKEN` is read only by
`gitquire wikis adopt`, which keeps it as the first wiki's token; the front door itself does not
use it and warns when it is set.

`GITQUIRE_ALLOWED_USERS` and `GITQUIRE_MCP_TOKEN` cannot be used with `GITQUIRE_WIKIS=on`: both
skip the check of who may write to a repository and would open every wiki. GitQuire refuses to
start with either set.

### Allowed owners

Only repositories under an allowed owner can become wikis, and a wiki keeps running only while its
owner is allowed. The front door checks this when a wiki is added, before each start of a wiki's
process and every ten minutes. Once the first wiki under a listed name is added, the owner is
remembered by its id on the host, so a renamed organisation stays allowed and someone who later
takes the old name does not. A wiki whose owner is taken off the list, or whose repository moves to
an owner that is not allowed, is **disconnected** and kept, never deleted; putting the owner back
connects it again at the next check (a restart checks at once). Inside an allowed owner, any
administrator of a repository may make it a wiki (on Forgejo, a server administrator).

### Who sees what

Sign-in, the session and the open-draft cookie are the front door's, at `/`. Everyone signs in with
the host as before; a person sees and opens a wiki only while they can write to its repository.
GitQuire asks the host with the person's own token at sign-in, once for each wiki, keeps the answer
for 5 minutes, and then asks again with its own token. A person who loses access is cut off within
a few minutes, also in open live editing. While the host cannot be reached, people already inside
stay and nobody new is let in; someone whose access is not confirmed gets the same "no wiki here"
answer as for any other address (page, API, live editing and `/mcp`), and the log line "cannot be
reached to check a person's access" names the wiki. When the host refuses GitQuire's own access to a repository (the
app was uninstalled, the bot was removed or is no longer an administrator, the token was revoked),
the wiki is **disconnected**: its administrators see why, nobody can open it, and nothing is
deleted.

A server administrator can **remove** a disconnected wiki on the wiki list (**Remove the wiki**,
with a box to tick), for example when its repository was deleted and its name should be free for a
new one. GitQuire stops the wiki's process, moves its folder from `wikis/<key>` to
`wikis-removed/<key>-<time>` (unpushed edits stay there), drops its Forgejo token and removes its
record; the log line "a disconnected wiki was removed" names where the files went. A wiki that is
still connected cannot be removed. Delete the kept folder by hand when it is no longer needed.

A person who cannot open a wiki is told there is no wiki at that address, whether it exists or
not; only its administrators see that it is disconnected. That holds for every address of the
wiki: its pages, files and images (also images that the editor loads from the root, which the front
door sends to the wiki named in the `Referer` only after the same check), live editing, drafts,
AI agents and mention counts.

`/` lists the wikis the signed-in person can open, with **Add a wiki** and the sentence "This
server hosts wikis from …" naming the allowed owners. Inside a wiki, the repository name in the
header opens a menu of the same wikis to switch between. The list and the menu show how many
unread mentions the person has in each wiki they can open, and the menu's badge counts those in
the other wikis; the front door counts them from each wiki's files and read marks, also for wikis
whose process is stopped. Mention mails and chat messages name the wiki; mail settings stay per wiki
for now.

### Add a wiki

**Add a wiki** (`/add-wiki`) asks the host once more for the person's repositories and lists those
under an allowed owner that the person administers and GitQuire can reach. A repository becomes a
wiki only when one of its administrators chooses **Make this a wiki**; GitQuire writes nothing into
any other repository. The list is kept for 30 minutes. After that the page asks the host again
(a new sign-in, usually without a prompt) and says so; a **Make this a wiki** sent on an expired list,
with the token entered, is kept in memory for ten minutes and carried out after that sign-in. The
log line "Add a wiki asks … again" gives the reason.

**On GitHub** any administrator of such a repository can make it a wiki, as long as the GitHub App
is installed on it. The page links the App's installation page for repositories it cannot reach
yet.

**On Forgejo** a server administrator adds each wiki, because Forgejo lets nobody but the bot
itself create the bot's tokens:

1. Make GitQuire's bot account an **Administrator** collaborator of the repository (the page names
   the account). With write access only, Forgejo refuses to tell GitQuire whether someone lost
   access.
2. Sign in to Forgejo as the bot, open **Settings → Applications**, and create a token with
   `write:repository`, **Specific repositories**, and only this repository.
3. Enter it on the Add a wiki page next to the repository and choose **Make this a wiki**.

GitQuire checks that the token can push to the repository, cannot read a person (a limited token
cannot), and is refused on another repository the bot can reach. **The bot must therefore reach at
least one more repository**, even an empty one; with none, the token cannot be confirmed and is
refused. Forgejo does not say whose token it is, so that cannot be checked. The front door keeps
these tokens in `/data/server/repo-tokens.json` (mode 0600). When a wiki's token expires or is
revoked, the wiki shows as disconnected with "token refused", and a server administrator enters a
new one in the wiki list.

### The volume

The volume holds `/data/server/` (the wiki table, the agent tokens and the Forgejo tokens) and one
folder per wiki, `/data/wikis/<host>-<repository id>/`, so a renamed repository keeps its folder;
its old address redirects to the new one. The `<host>` in addresses is the host's key: the kind
(`github` or `forgejo`) for the first host, and the key from `GITQUIRE_HOSTS` for a further one.

**Addresses carry the host.** Every wiki address names its host, also on a server with one host.
There are no other addresses for a wiki: `/w/<owner>/<repo>/…` and paths outside `/w/` are not
wiki addresses and answer as no wiki, so bookmarks and links from before this form stop working.
A wiki's drafts are kept beside it, in
`/data/wikis/.gitquire-drafts/<host>-<repository id>/`; `GITQUIRE_DRAFTS_DIR` and the `/drafts`
volume of `deploy/compose.yaml` are not used with several wikis. A volume is either one wiki or
several: the front door refuses a volume that holds a single wiki's checkout, and a single wiki
refuses a volume with `server/wikis.json` but no `.git` (a wiki's own repository may have a
`server/wikis.json`).

`docker stop` gives each wiki's process the time to commit and push what is not pushed yet
(within 50 seconds), so keep `stop_grace_period: 60s` as in `deploy/compose.yaml`.

### AI agents with several wikis

AI agents connect to the front door, not to a wiki: there is **one** address per Git host,
`https://<server>/mcp/<host key>` (for example `/mcp/forgejo`), and one connection or token per
person and host, whichever wikis they use. Each host has its own agents page,
`/auth/<host key>/agents`, its own connector sign-in (`GITQUIRE_MCP_CONNECTORS=on`) at
`/oauth/<host key>/…` with discovery at `/.well-known/oauth-protected-resource/mcp/<host key>` and
`/.well-known/oauth-authorization-server/oauth/<host key>`, and its own token store,
`/data/server/agent-tokens-<host key>.json` (hashed); no editor process has a token store of its
own. `/mcp` without a host key is not an address; it answers 404 and lists the addresses. Server
administrators of a host can revoke anyone's tokens there.

The agent sees a tool `list_wikis`, which lists the wikis the person can open, and the usual wiki
tools, each with an extra `wiki` argument naming the wiki with its host, as `list_wikis` does
(`github/team/handbook`); `team/handbook` alone is refused. A person with exactly one wiki may
leave it out. On every call the front door checks that the person may
open the named wiki, the same check as for the browser, and passes the call to that wiki's process
as that person; the edits are credited to them. `/w/<host>/<owner>/<repo>/mcp` is not an address: it
answers 404 and names the `/mcp/<host key>` address of the host in the address. **Settings → Connect AI** shows that address in
every wiki, and **Ask Claude** names the wiki in the prompt.

Each wiki tool also takes an optional `workspace` argument: `live`, `draft` (the draft the person
has open, otherwise the assistant's own draft for them) or `draft:<name>` for one named draft. The
front door keeps one connection per wiki and workspace, so a single conversation can work in the
live wiki and in a draft. A named draft that is not open is refused, never sent to the live wiki.
Without the argument a call follows the person's setting, as with one wiki. **Ask Claude** shows the
**Edits go to** switch and puts the choice into the prompt.

Every ten minutes the front door checks the owners of agent tokens and revokes a person's tokens
only when they can open no wiki on the server any more. While the host cannot be reached, nothing
is revoked. A person who can open no wiki gets no connection, and one person can keep at most
10 connections open at a time. While the host cannot be reached, connectors already approved keep
working, but a new connector cannot be approved.

AI chat is on inside each wiki. The front door gives each wiki's process a key for the saved AI
keys that is derived from `GITQUIRE_SESSION_SECRET` and the wiki, never the session secret itself,
so a person enters their API key once per wiki for now.

### Moving a single wiki over

`gitquire wikis adopt` moves a single-wiki volume into the several-wiki layout: the checkout of
`GITQUIRE_REPO` and its `.gitquire/local/` state (people, mentions, read marks, drafts, personal
settings, AI chats, saved AI keys) go to `/data/wikis/<host>-<repository id>/`, the repository
becomes the first wiki in `/data/server/wikis.json`, and the draft working copies are copied next
to it. `gitquire wikis unadopt` is the way back. Both run with the container stopped, in the same
environment as the front door, and never delete anything.

**Try it on a copy of the volume first.** Write the settings for several wikis into a separate
file, `gitquire-wikis.env`: your current settings plus `GITQUIRE_WIKIS=on`, `GITQUIRE_ALLOWED_OWNERS`
(or keep `GITQUIRE_REPO`), without `GITQUIRE_ALLOWED_USERS`, `GITQUIRE_MCP_TOKEN` and
`GITQUIRE_BRANCH`. Then:

```bash
docker compose stop gitquire
docker volume create gitquire-data-copy
docker volume create gitquire-drafts-copy
docker run --rm -v gitquire-data:/from:ro -v gitquire-data-copy:/to alpine cp -a /from/. /to/
docker run --rm -v gitquire-drafts:/from:ro -v gitquire-drafts-copy:/to alpine cp -a /from/. /to/
docker run --rm --env-file gitquire-wikis.env \
  -v gitquire-data-copy:/data -v gitquire-drafts-copy:/drafts -e GITQUIRE_DRAFTS_DIR=/drafts \
  -v "$PWD/app.pem:/run/secrets/app.pem:ro" \
  --entrypoint gitquire ghcr.io/docdru/gitquire:latest wikis adopt /data --dry-run
```

(On Forgejo, mount the token files instead of `app.pem` if your settings use `_FILE` variables.)
The dry run looks the repository up on the host, checks everything below (on Forgejo also
`GITQUIRE_HOST_REPO_TOKEN`) and lists every step without changing anything. Without `--dry-run` it
moves the copy. To look around, start a second container on the copy with the same env file, the
same mounts and another port, and set `GITQUIRE_EXTERNAL_URL` to that address; **its sign-in
callback (`<address>/auth/github/callback` or `/auth/forgejo/callback`) must be registered with the
GitHub App or the Forgejo OAuth application**. The trial is not a sandbox: it pushes to the real
repository and its draft branches, so edit with care or not at all. Then move the real volume the
same way, with the container stopped:

```bash
docker run --rm --env-file gitquire-wikis.env \
  -v gitquire-data:/data -v gitquire-drafts:/drafts -e GITQUIRE_DRAFTS_DIR=/drafts \
  -v "$PWD/app.pem:/run/secrets/app.pem:ro" \
  --entrypoint gitquire ghcr.io/docdru/gitquire:latest wikis adopt /data
```

and switch the service to `env_file: gitquire-wikis.env`.

What it does, and refuses:

- It stops with a message unless `GITQUIRE_WIKIS=on` is set, if GitQuire still runs on the volume
  (the single wiki's lock, or the front door's `/data/server/front-door.lock`), if the checkout is
  not a clone of `GITQUIRE_REPO` on the configured host, if it is not on the repository's default
  branch or `GITQUIRE_BRANCH` names another one (a wiki behind the front door always follows the
  default branch), if its owner is not allowed, if the host cannot be asked for the repository's
  id, or if anything is not pushed yet: uncommitted changes or commits ahead of the host, in the
  wiki or in a draft working copy. Start the single wiki again and let it push, or pass `--force`:
  the edits then move along and the wiki pushes them behind the front door.
- Running it again does only what is left. A move that was interrupted leaves
  `/data/.gitquire-moving-in` (or `.gitquire-moving-back` for the way back); while it is there,
  neither the single wiki nor the front door starts, and running the same command again finishes
  the move (only commits not yet pushed still need `--force` then).
- **Agent tokens move:** they are copied to the front door's store for the host,
  `/data/server/agent-tokens-<host>.json`, which has one writer, the front door. The address
  changes from `/mcp` to `/mcp/<host>`, so agents and connectors must be pointed at the new
  address; the tokens themselves keep working there. The original file stays in the wiki's folder,
  unused.
- **Saved AI keys** are re-sealed with the wiki's own key (see AI chat above), so people do not
  enter them again; the old files stay in `ai-keys.before-wikis`. This needs the
  `GITQUIRE_SESSION_SECRET` the single wiki ran with; if the keys do not open with it, the command
  says so and people enter their keys again.
- **Drafts:** each draft working copy is copied from the single wiki's drafts folder
  (`GITQUIRE_DRAFTS_DIR`, `/drafts` in `deploy/compose.yaml`) to
  `/data/wikis/.gitquire-drafts/<host>-<repository id>/`. The originals stay.
- **On Forgejo**, `GITQUIRE_HOST_REPO_TOKEN` becomes the first wiki's token in
  `/data/server/repo-tokens.json` after the same check as at Add a wiki (so the bot must reach
  another repository); the dry run already runs the check. If the check fails, or the setting is missing, the wiki shows as
  disconnected until a server administrator enters a token in the wiki list. Afterwards remove
  `GITQUIRE_HOST_REPO_TOKEN` from the settings.
- People stay signed in when `GITQUIRE_SESSION_SECRET` stays the same: the front door reads the
  single wiki's session cookie and asks the host about the person's access on the first request.

`gitquire wikis unadopt /data` works only while the server has exactly this one wiki. It refuses
unpushed edits as above (or takes `--force`), moves the checkout back to `/data`, re-seals the AI
keys with `GITQUIRE_SESSION_SECRET`, puts the front door's agent tokens back as the single wiki's
(the older file is kept beside it), copies the draft working copies back to `GITQUIRE_DRAFTS_DIR`
(an existing one is kept beside it with `.before-single-wiki-<time>`), and keeps everything else of
the front door (the wiki table, the Forgejo tokens, the drafts folder) in
`/data/.gitquire/local/gitquire/several-wikis-<time>/`. Then start the container with
`GITQUIRE_WIKIS` off and, on Forgejo, with `GITQUIRE_HOST_REPO_TOKEN` again. It also takes
`--dry-run`, and an interrupted run is finished by running it again.

A volume that holds several wikis (`server/wikis.json` without `.git`) or an unfinished move is
refused when the container starts with `GITQUIRE_WIKIS` off, before anything is written to it.

### Two Git hosts on one server

One front door can serve wikis from **GitHub and one Forgejo server** together; this combination is
tested (against the real Forgejo 15 and a GitHub fake; the real GitHub has not been tried with two
hosts yet). The host you configure as today is the **first host**. Further hosts are listed in
`GITQUIRE_HOSTS` and each is described by its own variables, `GITQUIRE_HOST_<KEY>_…`:

```env
GITQUIRE_WIKIS=on
GITQUIRE_HOST=forgejo
GITQUIRE_HOST_URL=https://git.example.com
GITQUIRE_HOST_CLIENT_ID=…
GITQUIRE_HOST_CLIENT_SECRET=…
GITQUIRE_HOST_TOKEN_FILE=/run/secrets/forgejo-bot
GITQUIRE_ALLOWED_OWNERS=team
GITQUIRE_ADMINS=alice

GITQUIRE_HOSTS=github
GITQUIRE_HOST_GITHUB_CLIENT_ID=…
GITQUIRE_HOST_GITHUB_CLIENT_SECRET_FILE=/run/secrets/github-client-secret
GITQUIRE_HOST_GITHUB_APP_ID=123456
GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/app.pem
GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS=team
GITQUIRE_HOST_GITHUB_ADMINS=alice
```

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_HOSTS` | The keys of the further hosts, separated by commas. A key is lower-case letters, digits and dashes, starting with a letter; it appears in addresses (`/w/<key>/…`) and person ids, so do not change it later. A key that is `github` or `forgejo` is also the kind. |
| `GITQUIRE_HOST_<KEY>_KIND` | `github` or `forgejo`; may be left out when the key is the kind. |
| `GITQUIRE_HOST_<KEY>_URL`, `_API_URL` | The host's https address; for GitHub default `https://github.com` (then the API is `https://api.github.com`, otherwise `<url>/api/v3`), for Forgejo required (the API defaults to `<url>/api/v1`). |
| `GITQUIRE_HOST_<KEY>_CLIENT_ID`, `_CLIENT_SECRET` (or `_FILE`) | The sign-in application of this host. Its callback is `<server>/auth/<key>/callback`. |
| GitHub: `GITQUIRE_HOST_<KEY>_APP_ID`, `_APP_PRIVATE_KEY_FILE` (or `_APP_PRIVATE_KEY`) | The GitHub App, as for the first host. |
| Forgejo: `GITQUIRE_HOST_<KEY>_TOKEN` (or `_FILE`) | The bot's unlimited token, as `GITQUIRE_HOST_TOKEN`. |
| `GITQUIRE_HOST_<KEY>_ALLOWED_OWNERS` | Required: the owners on this host whose repositories may become wikis. |
| `GITQUIRE_HOST_<KEY>_ADMINS` | Server administrators on this host. `GITQUIRE_ADMINS` is for the first host only. |
| `GITQUIRE_HOST_<KEY>_LABEL`, `_COMMIT_EMAIL_FORMAT` | Optional: the name shown to people, and the commit address format. |

A single wiki (`GITQUIRE_WIKIS` off) refuses `GITQUIRE_HOSTS`. Two hosts with the same address
are refused. With one host, nothing above is needed.

**People sign in once per host.** The sign-in page (`/auth/sign-in`) offers each host; a person can
be signed in with both at once, and each account sees the wikis of its own host. Accounts are never
linked: the same login, even the same number, on two hosts is two people, with their own access
checks, mentions, settings and agent tokens. **Sign out…** in the wiki menu signs out of one host
or all. The wiki list joins both accounts' wikis, names each `<host>/<owner>/<repo>` and keeps
answering when one host is slow or down (that host's wikis are left out after a few seconds). Add a
wiki asks which host when two are signed in. Server administrators are per host: an administrator
on one host has no say over the other's wikis or tokens.

**AI agents have one address per host**, because one connection acts as one person. Every host,
the first included, is addressed by its key:

| | Host `<key>` |
| --- | --- |
| MCP address and connector | `/mcp/<key>` |
| Tokens and connected apps | `/auth/<key>/agents` |
| Token store | `/data/server/agent-tokens-<key>.json` |

A token or connector reaches only its host's wikis and is refused at the other address. Someone
with accounts on both hosts adds two connectors (for example "GitQuire Forgejo" and "GitQuire
GitHub"). Inside a wiki, **Settings → Connect AI** shows the address of that wiki's host.

**Going back** to an image without several hosts: first remove the further hosts' wikis (or keep a
copy of the volume from before). An older image reads the wiki table but not the host key of a
further host's wiki, and would take such a wiki for one of the first host's.

### Known limits

- One GitHub and one Forgejo per server are tested; more hosts may work but are not promised.
  Accounts on two hosts are not linked, and an AI connection reaches one host.
- About 250 MB of memory per wiki in use, and the same per draft in use. A wiki's process starts
  when someone opens it (a few seconds) and stops after 30 minutes without use.
- All wikis share one browser origin and one container user; the separation is the front door's
  access check and one process, folder and token per wiki.
- On Forgejo, only server administrators add wikis, each needs its own limited token made while
  signed in as the bot, the bot is repository administrator (more than editing needs), and a limited
  token can still read the details (not the files) of other repositories the bot belongs to.
- The front door asks the host once per wiki at sign-in; with many wikis (roughly 50 and more)
  sign-in gets slower.
- Mentions in files a wiki hides from its file tree are still counted and mailed by the front door.
- The way back (`unadopt`) is for a server that still has only the moved wiki.
- Whether an AI assistant such as Claude uses the `wiki` argument well has not been tried with a
  real connector yet.

### Timing of access checks and stops

| Setting | Meaning |
| --- | --- |
| `GITQUIRE_ACCESS_CHECK_SECONDS` | How long the front door keeps a person's access answer before asking the host again, 1 to 3600, default 300. Open live-editing connections are checked every minute, or at this interval when it is shorter, so a person who loses access is cut off within this time plus a minute. Shorter means more host calls. |
| `GITQUIRE_WIKI_IDLE_MINUTES` | How long a wiki's process keeps running without use, default 30. It stops only once it is pushed and clean, and starts again on the next request. |
| `GITQUIRE_BRANCH_WATCH_SECONDS` | How often the front door asks the host whether a sleeping wiki's branch moved, at least 10, default 600. After a failed check a wiki is asked again after twice the time, up to two hours. |
| `GITQUIRE_PROCESS_HEAP_MB` | Heap limit in MB for each wiki and draft process (Node's `--max-old-space-size`), 64 to 65536, default 256; `0` for no limit. Without a limit each process sizes its heap from the whole machine's memory and keeps garbage it has not collected yet. |

## Build the image yourself

```bash
docker build -t gitquire:local .
```

CI builds and smoke-tests the image on every pull request and publishes it to
`ghcr.io/docdru/gitquire` from `main` (see [`.github/workflows/docker.yml`](./.github/workflows/docker.yml)).

## Versions and upgrades

The image is published under these tags:

| Tag | What it is | Use it for |
| --- | --- | --- |
| `0.3.1` | One released version; never moves | A server people rely on |
| `0.3` | The newest `0.3.x` release | Taking fixes without reading release notes |
| `latest` | The newest commit on `main`, released or not | A test server |
| `sha-<commit>` | One commit on `main` | Going back to an exact build |

Each release is listed with its changes on the
[releases page](https://github.com/docdru/GitQuire/releases). While the version starts with `0.`,
a new middle number (`0.3` to `0.4`) means the upgrade may need a manual step, which the release
notes name; a new last number never does.

To upgrade a server that is pinned to a version:

1. Read the release notes of every version in between.
2. Back up the volume:
   `docker run --rm -v gitquire-data:/data -v "$PWD":/b alpine tar czf /b/gitquire-data.tgz -C /data .`
3. Change the version in the `image:` line of `compose.yaml`.
4. `docker compose pull && docker compose up -d`

To go back, put the old version in the `image:` line and repeat step 4. When the release notes say
an upgrade changes files on the volume, restore the backup as well. Edits that were already pushed
to GitHub stay there.

`docker compose exec gitquire gitquire --version` prints the version a running server has. An
image built from `main` between two releases reports the version of the last release.

## Upgrading from the old names

Older versions read `OK_*` environment variables (`OK_ALLOW_EXTERNAL`, `OK_EXTERNAL_URL`,
`OK_BIND`, `OK_FILE_WATCHER_BACKEND`, …). They are now `GITQUIRE_*` with the same rest of the name.
The old names still work for now: at start, each `OK_*` variable whose `GITQUIRE_*` twin is not set
is used under the new name, and the log shows one line per variable, for example
`The environment variable OK_ALLOW_EXTERNAL is now GITQUIRE_ALLOW_EXTERNAL.` When both are set, the
`GITQUIRE_*` value wins.

To upgrade, rename the variables in your `gitquire.env` or compose file and restart:

```bash
sed -i 's/^OK_/GITQUIRE_/' gitquire.env
```

One case needs this rename before the old name takes effect: the image itself sets
`GITQUIRE_BIND=0.0.0.0`, so an `OK_BIND` of your own is ignored. Rename it to `GITQUIRE_BIND`.

The `ok` and `open-knowledge` commands are now `gq` and `gitquire`; the old commands still work and
print a notice.

The data folder `.ok/` is now `.gitquire/` (in the project, in every folder that has its own
templates or settings, and `~/.ok` in the home folder). Nothing to do by hand: on the first start
after the upgrade, GitQuire moves each `.ok/` to `.gitquire/`, updates `.ok` lines in
`.git/info/exclude`, and logs one line per move. With GitHub sync on, the next sync commits the
move as a rename (`.ok/config.yml` → `.gitquire/config.yml`, templates and schemas likewise);
`.gitquire/local` stays out of Git as before. Before and after:

- **Back up the volume first** (`docker run --rm -v gitquire-data:/data -v "$PWD":/b alpine tar czf
  /b/gitquire-data.tgz -C /data .`). The move is a plain rename and can be undone by renaming back,
  but only before the next sync.
- If a folder has both `.ok/` and `.gitquire/`, GitQuire uses `.gitquire/`, leaves `.ok/` (on disk
  and in Git) in place and says so in the log; merge what you need by hand.
- Other copies of the wiki still running an older GitQuire stop finding their settings once the
  rename arrives through Git. Upgrade them too.

## Environment variable reference

| Variable | Section |
| --- | --- |
| `PORT`, `GITQUIRE_BIND`, `GITQUIRE_ALLOW_EXTERNAL`, `GITQUIRE_EXTERNAL_URL` | [Quick start](#quick-start) |
| `GITQUIRE_GIT_NAME`, `GITQUIRE_GIT_EMAIL` | [Quick start](#quick-start) |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITQUIRE_SESSION_SECRET` | [GitHub sign-in](#github-sign-in) |
| `GITQUIRE_REPO`, `GITQUIRE_ALLOWED_USERS`, `GITQUIRE_ADMINS`, `GITQUIRE_SESSION_DAYS`, `GITQUIRE_AUTH` | [GitHub sign-in](#github-sign-in) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_APP_PRIVATE_KEY` | [Sync a GitHub repository](#sync-a-github-repository) |
| `GITQUIRE_BRANCH`, `GITQUIRE_SYNC_MODE`, `GITQUIRE_COMMIT_EMAIL_FORMAT` | [Sync a GitHub repository](#sync-a-github-repository) |
| `GITQUIRE_HOST`, `GITQUIRE_HOST_URL`, `GITQUIRE_HOST_API_URL`, `GITQUIRE_HOST_CLIENT_ID`, `GITQUIRE_HOST_CLIENT_SECRET` | [Forgejo](#forgejo) |
| `GITQUIRE_HOST_TOKEN`, `GITQUIRE_HOST_TOKEN_FILE`, `GITQUIRE_HOST_REPO_TOKEN`, `GITQUIRE_HOST_REPO_TOKEN_FILE` | [Forgejo](#forgejo) |
| `GITQUIRE_SMTP_URL`, `GITQUIRE_MAIL_FROM`, `GITQUIRE_MAIL_DOMAINS` | [Mention emails](#mention-emails) |
| `GITQUIRE_CHAT_WEBHOOK_URL`, `GITQUIRE_CHAT_FORMAT` | [Chat notifications](#chat-notifications) |
| `GITQUIRE_DRAFTS_DIR` | [Drafts](#drafts) |
| `GITQUIRE_AGENT_TOKEN_DAYS`, `GITQUIRE_MCP_CONNECTORS`, `GITQUIRE_MCP_TOKEN` | [AI agents](#ai-agents) |
| `GITQUIRE_AI_CHAT`, `GITQUIRE_ANTHROPIC_BASE_URL`, `GITQUIRE_MISTRAL_BASE_URL` | [AI chat](#ai-chat) |
| `GITQUIRE_SEMANTIC_SEARCH`, `GITQUIRE_EMBEDDINGS_API_KEY`, `GITQUIRE_EMBEDDINGS_URL`, `GITQUIRE_EMBEDDINGS_MODEL` | [Search by meaning](#search-by-meaning) |
| `GITQUIRE_NAMING` | [Wiki administration](#wiki-administration) |
| `GITQUIRE_BEHIND_FRONT_DOOR`, `GITQUIRE_DOOR_TOKEN_SOCKET` | [Behind GitQuire's front door](#behind-gitquires-front-door) |
| `GITQUIRE_WIKIS`, `GITQUIRE_ALLOWED_OWNERS` | [Several wikis](#several-wikis) |
| `GITQUIRE_HOSTS`, `GITQUIRE_HOST_<KEY>_…` | [Two Git hosts on one server](#two-git-hosts-on-one-server) |
| `GITQUIRE_ACCESS_CHECK_SECONDS`, `GITQUIRE_WIKI_IDLE_MINUTES`, `GITQUIRE_BRANCH_WATCH_SECONDS`, `GITQUIRE_PROCESS_HEAP_MB` | [Several wikis](#timing-of-access-checks-and-stops) |
