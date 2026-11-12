# GitQuire

A collaborative, WYSIWYG Markdown wiki for small teams, with GitHub as the backend.

- **Write together.** A Notion-like editor with live cursors, for meetings and for async work.
- **Plain Markdown in Git.** Every page is a `.md` file in a GitHub repository. Edits are committed to `main` automatically after a short pause.
- **Branches and pull requests when you need them.** Propose a new report on a branch and open a PR from the editor.
- **Links that stay correct.** `[[wiki links]]`, backlinks, and links rewritten when a page is renamed.
- **Comments in the file.** Threads live in a hidden block at the end of each Markdown file, so everything stays in Git.
- **Self-hosted.** One Docker container with a `/data` volume.

> **Status:** early, but usable. The phases of the [roadmap](#roadmap) are in; what comes next
> depends on feedback.

## Run it

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

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `OK_BIND` | `0.0.0.0` | Bind address |
| `OK_ALLOW_EXTERNAL` | unset | Must be `1` to accept non-local connections |
| `OK_EXTERNAL_URL` | unset | Public origin, required behind a domain or proxy |
| `GITQUIRE_GIT_NAME`, `GITQUIRE_GIT_EMAIL` | `GitQuire`, `gitquire@localhost` | Git identity for commits not made by a signed-in person |

### GitHub sign-in

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
| `GITQUIRE_AGENT_TOKEN_DAYS` | How long a personal agent token stays valid, default 90. |
| `GITQUIRE_ASK_AI` | `on` shows the editor's **Ask AI** box and the empty screen's prompt box. Off by default, because they hand work to an agent running on the server, which a shared team server doesn't have. While it is off, people with agent access get the **Ask Claude** box instead. |
| `GITQUIRE_MCP_CONNECTORS` | `on` lets Claude on the web, desktop chat and phones connect through GitHub sign-in. Needs a public `https://` URL. |
| `GITQUIRE_MCP_TOKEN` | Optional shared token for `/mcp`. Prefer personal agent tokens: edits made with the shared token are not credited to anyone. |
| `GITQUIRE_SESSION_DAYS` | Session length, default 7. |
| `GITQUIRE_AUTH` | `off` disables sign-in even when a client ID is set. |

Sign out at `/auth/logout` (a page with a sign-out button; the session is cleared by its POST). `/auth/me` returns the signed-in user as JSON.

### Sync a GitHub repository

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
(exit code 78). The volume keeps the checkout between restarts. On an empty repository, GitQuire starts the branch
and pushes the first commit. Commits are authored by the people who made the edits; changes
without a signed-in person are authored as `GITQUIRE_GIT_NAME` / `GITQUIRE_GIT_EMAIL`.

### Branches and pull requests

Everyone edits one working copy, so the branch is shared: switching it moves every open editor to
that branch. Work on `main` by default; to propose something bigger, create a branch, switch to it,
edit, and open a pull request once the branch has synced to GitHub. Pull requests are opened by the
GitHub App, with the proposer's GitHub login in the description, so the app also needs **Pull
requests: read and write**.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/gitquire/branches` | Current, base, local and remote-only branches. |
| `POST /api/gitquire/branches` | Create a branch: `{"name": "report/q4", "from": "main"}` (`from` defaults to the current state). |
| `GET /api/gitquire/pulls` | Open pull requests on the repository. |
| `POST /api/gitquire/pulls` | Open a pull request from the current branch: `{"title": "…", "body": "…", "draft": false}`. |

Switching uses the existing `POST /api/git/checkout`. Any signed-in member may switch or create
branches.

Build the image yourself:

```bash
docker build -t gitquire:local .
```

## Page names and links

GitQuire keeps file names link-friendly: when you create or rename a page or folder, the new name
is turned into lowercase words joined by hyphens, so *Meeting Notes 2026* is saved as
`meeting-notes-2026.md`. A new page keeps what you typed as its `# Title`. Existing folders keep
their names, and names starting with `.` or `_` are left alone. Set `GITQUIRE_NAMING=off` to keep
names exactly as typed.

Links don't break: `[[Meeting Notes 2026]]` finds `meeting-notes-2026.md`, renames and moves
rewrite the links that point at the page, and the backlinks panel shows who links where.

## AI agents

Each person connects their own AI agent, with their own Claude (or other) account. Nothing runs
on the server on their behalf.

1. Sign in and open `/auth/agents` (also linked from `/auth/logout`).
2. Create a token. The page shows it once, with the command for Claude Code and the config for the
   Claude desktop app:

   ```bash
   claude mcp add --transport http gitquire https://wiki.example.com/mcp \
     --header "Authorization: Bearer gqa_…"
   ```

3. Ask the agent to work on the wiki. Its edits show up live and are committed with you as the
   author.

### Ask Claude from the editor

Once you have an agent token or a connected app, an **Ask Claude** box appears at the bottom of
pages and folders (on wider screens). Type a request and press Enter: Claude opens with the
request, the wiki and the current page already filled in, ready for you to check and send. Pick
where it opens: Claude on the web or phone, the Claude desktop app, or Claude Code in the desktop
app. The box only fills in the request; Claude reaches the wiki through your own connection.

### Claude on the web and on phones

With `GITQUIRE_MCP_CONNECTORS=on`, `/mcp` also speaks the sign-in protocol that cloud connectors
use (OAuth 2.1 with PKCE, client metadata documents and dynamic registration). In Claude's
settings, add a custom connector with the address `https://wiki.example.com/mcp`. A popup opens,
you sign in with GitHub and approve, and Claude can then work on the wiki from any device, as you.

The connection comes from Anthropic's servers, so the wiki must be reachable on the public
internet over HTTPS. GitHub sign-in and the repository's write access still decide who gets in.
Each connected app shows up on `/auth/agents`, where it can be revoked. Its access token lasts an
hour and is renewed with a refresh token for up to 90 days of inactivity.

Tokens are stored hashed in `.ok/local/gitquire/agent-tokens.json` on the data volume, never in
the repository. Revoke one from the same page; admins (`GITQUIRE_ADMINS`) can revoke anyone's.
Every ten minutes the server checks that token owners can still write to `GITQUIRE_REPO` (using
the GitHub App when it is configured) and revokes the tokens of people who lost access.

## Discussions

Select text and choose **Discuss** to start a thread. Teammates reply, mention each other with
`@login`, and resolve threads when they are done. Threads are saved in the page itself, in a block
at the end of the Markdown file that GitHub doesn't render:

```markdown
<!-- gitquire-comments v1
{"id":"…","anchor":{"exact":"quarterly numbers","prefix":"…","suffix":"…"},"resolved":false,"comments":[…]}
-->
```

Each thread is one JSON line, so diffs and merges stay readable and comments travel with the page
through branches and pull requests. A thread finds its passage again by the quoted text and its
surroundings; if the text is gone, the thread says so.

You can edit and delete your own comments; edited ones are marked, and earlier versions stay in the
Git history. When two people comment on the same page at the same moment, both comments are kept.

### Mentions

The **@** button in the header lists the discussions where someone mentioned you, newest first,
with a count of unread ones. Choosing a mention opens the page at that thread. The inbox needs
GitHub sign-in. The mentions stay in the pages; who has read what, and the email settings below,
are kept on the server in `/data/.ok/local/gitquire/mentions.json`, outside Git.

Mentions can also go out by email. People enter their address under the mention list and get a
confirmation mail with a code; email starts once they enter the code in GitQuire. Codes are valid
for 24 hours and allow five tries. A new code can be requested after a minute; at most five
confirmation mails go out per person and three per address a day, and 30 an hour for the whole
server. Once a minute, new mentions they have not read yet are mailed; mentions that already
existed when the address was confirmed are not. The server needs an SMTP server for this:

| Variable | Meaning |
| --- | --- |
| `GITQUIRE_SMTP_URL` | `smtps://user:password@host:465` or `smtp://user:password@host:587`. Without it, email is off. |
| `GITQUIRE_MAIL_FROM` | Sender address. Required; without a valid one, email stays off and a warning is logged. |
| `GITQUIRE_MAIL_DOMAINS` | Optional comma-separated domains people may enter, for example `acme.com`. Without it, any address is accepted. |

With `smtp://`, STARTTLS is required; add `?starttls=off` only for a local relay, and a password is
then only sent to `localhost`. Mail is limited to 20 per person per day and 100 per hour in total;
the counts start over when the server restarts. People who have not opened GitQuire for 30 days get
no mail. The link in the mail is built from `OK_EXTERNAL_URL`; without it, the mail has no link.

## Broken links

The broken-links button in the header shows how many links point to pages that do not exist. It
lists each missing page with the pages that link to it, so you can open them and fix the link. Set
`validation.links: off` to hide it. Links from `log` pages and from agent folders (`.agents`,
`.claude`, `.cursor`) are not listed.

## Views: pages as objects

Give a page properties (frontmatter) and it becomes an object you can list. There is no schema: a
page has whatever properties you give it.

```markdown
---
type: task
status: Doing
owner: alice
due: 2026-12-01
---

# Rework the landing page

- [ ] Draft the copy @bob
- [x] Collect screenshots
```

The **Views** button in the header opens three tabs. It is hidden on phone-width screens.

- **Table**: every page with properties. Choose columns, filter by a property and value, search and
  sort.
- **Board**: columns from a property with a few values, such as `status`. Move a card by dragging
  it or with its "Move to" list; the property is changed in the page and committed in your name.
- **Action items**: every open task list item of every page, grouped by page. Filter to items that
  @mention you, a teammate or nobody; tick "Show done" to see finished ones.

Table and board settings are saved per browser.

The data comes from `GET /api/gitquire/objects`.

## Roadmap

Done:

1. **Shared server in Docker** with CI and a published image.
2. **GitHub sign-in**, live editing on `main`, per-user commit authorship.
3. **Branches and pull requests** from the editor.
4. **Comments stored in the Markdown files**: threads, editing, simultaneous comments, a mention
   inbox and email.
5. **Mobile**: toolbar above the keyboard, installable as a home-screen app. The touch link
   picker is in review (#26).
6. **Linking**: naming rules, rename rewrite, backlinks and a broken-link list.
7. **Pages as objects**: table, board and action items from frontmatter and task lists.

Next, depending on feedback:

- **Pull request review**: GitHub review comments shown as page threads, or reviewing fully inside
  GitQuire.
- **More views**: a meeting-notes timeline; ticking off action items from the list.
- **Chat notifications** for mentions (Slack, Teams, Matrix).

## Credits and license

GitQuire is a fork of [OpenKnowledge](https://github.com/inkeep/open-knowledge) by Inkeep, Inc., and
keeps its history. The original README is in [UPSTREAM-README.md](./UPSTREAM-README.md). Parts of the
GitHub, branch, PR and comment features will be adapted from
[GitMarkdown](https://github.com/pooriaarab/gitmarkdown) by Pooria Arab (MIT).

GitQuire is licensed under the [GNU General Public License v3.0 or later](./LICENSE), like
OpenKnowledge. GitQuire is not affiliated with or endorsed by Inkeep.
