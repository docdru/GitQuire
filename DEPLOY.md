# Deploying GitQuire

GitQuire ships as one Docker image, `ghcr.io/docdru/gitquire`, with all state in a `/data` volume.
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

To keep these options in a file, use [`deploy/compose.yaml`](./deploy/compose.yaml). Put it in a
folder with `gitquire.env` (the variables from this page, one `NAME=value` per line) and, for
repository sync, the GitHub App key as `app.pem` with
`GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/app.pem`. Then:

| Task | Command |
| --- | --- |
| Start, or apply a changed `gitquire.env` | `docker compose up -d` |
| Update to the latest image | `docker compose pull && docker compose up -d` |
| Follow the log | `docker compose logs -f gitquire` |
| Start the Mailpit test inbox on port 8025 | `docker compose --profile mail-test up -d` |

If something else already uses port 8080 on the host, change only the left side of the mapping
(`127.0.0.1:8082:8080`) and point nginx's `proxy_pass` at that port. Mailpit is reachable from
GitQuire as `smtp://mailpit:1025?starttls=off`.

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

If GitHub is unreachable at start, GitQuire retries for about five minutes before giving up
(exit code 75, so a restart policy can try again); configuration problems stop it immediately
(exit code 78). The volume keeps the checkout between restarts. On an empty repository, GitQuire
starts the branch and pushes the first commit. Commits are authored by the people who made the
edits; changes without a signed-in person are authored as `GITQUIRE_GIT_NAME` /
`GITQUIRE_GIT_EMAIL`.

## Drafts

People edit the live wiki, or a draft: their own copy that becomes live when someone publishes it
(see [Drafts](https://github.com/docdru/GitQuire/blob/main/docs/content/gitquire/drafts.mdx)). Drafts
need GitHub sign-in; with the GitHub App, each draft is a `draft/<name>` branch and a pull request,
so the App needs **Pull requests: read and write** and **Contents: read and write**. Without the App,
drafts use the repository's `origin` remote directly and are published by a squash merge.

For each draft in use, the server starts one more editor process on a loopback port, with its own
working copy, and forwards the people who opened that draft to it. A process needs about 250 MB of
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

## People you can mention

Typing `@` in a comment or a page offers the people who use this wiki: everyone who has signed in,
the repository's collaborators with write access (read through the GitHub App, cached for ten
minutes; if GitHub refuses, only the other two sources are used) and `GITQUIRE_ALLOWED_USERS`. The
list of people who signed in is kept in `.ok/local/gitquire/people.json` on the data volume.

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
assistant's edits go into a [draft](#drafts) instead of the live wiki.

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

Tokens are stored hashed in `.ok/local/gitquire/agent-tokens.json` on the data volume, never in
the repository. Revoke one from `/auth/agents`; admins (`GITQUIRE_ADMINS`) can revoke anyone's.
Every ten minutes the server checks that token owners can still write to `GITQUIRE_REPO` (using
the GitHub App when it is configured) and revokes the tokens of people who lost access.

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_AGENT_TOKEN_DAYS` | How long a personal agent token stays valid, default 90. |
| `GITQUIRE_MCP_CONNECTORS` | `on` lets Claude on the web, desktop chat and phones connect through GitHub sign-in. Needs a public `https://` URL. |
| `GITQUIRE_MCP_TOKEN` | Optional shared token for `/mcp`. Prefer personal agent tokens: edits made with the shared token are not credited to anyone. |
| `GITQUIRE_ASK_AI` | `on` turns on the in-app agents: the ✨ Agents pane (⌘L), the editor's **Ask AI** box and the empty screen's prompt box. Off by default; read [In-app agents](#in-app-agents) first. While it is off, the server refuses agent sessions and people with agent access get the **Ask Claude** box instead. |

### In-app agents

The ✨ Agents pane is a chat with an AI agent (Claude Code, Codex and others) that runs **on the
GitQuire server**, not on each person's computer. It's off by default; with `GITQUIRE_ASK_AI` unset
the pane shows the [AI chat](#ai-chat) instead, and the server refuses agent sessions and agent
setup requests (HTTP 403). The AI chat or connecting Claude through **Settings → Connect AI** is
the recommended way for a team.

If you turn it on, know what you're choosing:

- **One AI account for everyone.** The agent signs in once on the server (its own login step, or an
  API key such as `ANTHROPIC_API_KEY` in the server's environment), and every member's chats use it. Personal
  Claude subscriptions are meant for one person, so a team needs an API key, billed per use, with
  no per-person limits in GitQuire.
- **The agent runs as the server.** It can run commands and read files inside the container,
  including the data volume and any secrets the server can read, such as the GitHub App's private
  key. Everyone who can sign in can start one.
- **Network and disk.** The server downloads the agent's adapter when it first starts (the
  container needs internet access), and keeps agent logins and chat history on the server.
- **Inherited behaviour.** The pane comes from OpenKnowledge, which was built for one person on one
  computer. How agent edits are credited and who can see whose chats have not been adapted for
  teams.

It can make sense for a small team that trusts each other, runs GitQuire on its own server, and
wants agents to share one API key. Turn it on with `GITQUIRE_ASK_AI=on`; members then set up the
agents under **Settings → Connect Claude**, below the connector steps.

## AI chat

People can chat with Claude or Mistral in the ✨ pane (⌘L) and from the box under each page. The
assistant searches, reads and, when asked, edits pages through the same tools as `/mcp`, so its
changes appear live, are credited to the person chatting, and follow their **Put my AI assistant's
edits into a draft** setting. It cannot delete pages, change settings, read hidden folders such as
`.ok` (where keys and chats are kept) or run commands.

It is on whenever GitHub sign-in is on and in-app agents (`GITQUIRE_ASK_AI`) are off; the ✨ pane
then shows the chat. Nothing runs until someone adds a key:

- **Each person uses their own API key** from the [Claude Console](https://platform.claude.com) or
  [Mistral La Plateforme](https://console.mistral.ai), entered under **Settings → AI chat**. GitQuire
  checks the key with the provider, then stores it encrypted (AES-256-GCM, key derived from
  `GITQUIRE_SESSION_SECRET`) in `/data/.ok/local/gitquire/ai-keys/`. It never sends a key anywhere
  but to its provider and never shows it again. Changing `GITQUIRE_SESSION_SECRET` makes saved keys
  unreadable; people then paste them again.
- **Spending is each person's responsibility.** They pay their provider per use and should set a
  monthly spending limit there; the settings page links to it. Each message is capped at 16,000
  output tokens (thinking included) and 12 tool steps, older tool results are shortened in long
  chats, and the chat shows the tokens a conversation has used.
- **Chats are kept per person** in `/data/.ok/local/gitquire/chats/<GitHub user id>/`, outside Git,
  and deleted 90 days after their last message. Only their owner sees them in the app; whoever runs
  the server can read the files. **Save as page** writes a chat into the wiki.
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
  `.ok/local/embeddings/`.

The key is only ever sent to `GITQUIRE_EMBEDDINGS_URL`. There is no Search page in the app's
settings: the environment is the only place to change this.

## Wiki administration

Settings under **User** in the app are personal: with GitHub sign-in on, each person's are saved
on the data volume in `.ok/local/gitquire/users/<GitHub user id>.yml`, outside Git.

Settings under **Wiki administration** apply to everyone: attachments, content rules, sync, link
previews, plugins, templates, skills and ignore patterns. Most are saved in the repository
(`.ok/config.yml`, `.okignore`, `.ok/templates/`); sync and link previews are saved on the data
volume in `.ok/local/config.yml`.

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
| `GITQUIRE_DRAFTS_DIR` | [Drafts](#drafts) |
| `GITQUIRE_AGENT_TOKEN_DAYS`, `GITQUIRE_MCP_CONNECTORS`, `GITQUIRE_MCP_TOKEN`, `GITQUIRE_ASK_AI` | [AI agents](#ai-agents) |
| `GITQUIRE_AI_CHAT`, `GITQUIRE_ANTHROPIC_BASE_URL`, `GITQUIRE_MISTRAL_BASE_URL` | [AI chat](#ai-chat) |
| `GITQUIRE_SEMANTIC_SEARCH`, `GITQUIRE_EMBEDDINGS_API_KEY`, `GITQUIRE_EMBEDDINGS_URL`, `GITQUIRE_EMBEDDINGS_MODEL` | [Search by meaning](#search-by-meaning) |
| `GITQUIRE_NAMING` | [Wiki administration](#wiki-administration) |
