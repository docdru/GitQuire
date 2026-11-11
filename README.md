# GitQuire

A collaborative, WYSIWYG Markdown wiki for small teams, with GitHub as the backend.

- **Write together.** A Notion-like editor with live cursors, for meetings and for async work.
- **Plain Markdown in Git.** Every page is a `.md` file in a GitHub repository. Edits are committed to `main` automatically after a short pause.
- **Branches and pull requests when you need them.** Propose a new report on a branch and open a PR from the editor.
- **Links that stay correct.** `[[wiki links]]`, backlinks, and links rewritten when a page is renamed.
- **Comments in the file.** Threads live in a hidden block at the end of each Markdown file, so everything stays in Git.
- **Self-hosted.** One Docker container with a `/data` volume.

> **Status:** early. GitQuire is being built in phases: the Docker image and GitHub sign-in work
> today, and syncing a GitHub content repo is being added. Per-user commit authorship, branches and PRs, shared
> comments, mobile polish and naming rules follow. See the [roadmap](#roadmap).

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
| `GITQUIRE_GIT_NAME`, `GITQUIRE_GIT_EMAIL` | `GitQuire`, `gitquire@localhost` | Git identity for commits until per-user sign-in lands |

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
| `GITQUIRE_MCP_TOKEN` | Optional bearer token for AI agents on `/mcp`; without it `/mcp` is closed. |
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
and pushes the first commit. Until per-user authorship lands, commits are authored as
`GITQUIRE_GIT_NAME` / `GITQUIRE_GIT_EMAIL`.

Build the image yourself:

```bash
docker build -t gitquire:local .
```

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

## Roadmap

1. **Shared server in Docker** with CI and a published image.
2. **GitHub sign-in**, live editing on `main`, per-user commit authorship.
3. **Branches and pull requests** from the editor.
4. **Comments stored in the Markdown files**, with threads, mentions and PR comment sync.
5. **Mobile**: toolbar above the keyboard, touch link picker, installable as a home-screen app.
6. **Linking**: naming rules on top of the existing rename rewrite and backlinks.

Later: pages as objects, with frontmatter-driven table, timeline and kanban views.

## Credits and license

GitQuire is a fork of [OpenKnowledge](https://github.com/inkeep/open-knowledge) by Inkeep, Inc., and
keeps its history. The original README is in [UPSTREAM-README.md](./UPSTREAM-README.md). Parts of the
GitHub, branch, PR and comment features will be adapted from
[GitMarkdown](https://github.com/pooriaarab/gitmarkdown) by Pooria Arab (MIT).

GitQuire is licensed under the [GNU General Public License v3.0 or later](./LICENSE), like
OpenKnowledge. GitQuire is not affiliated with or endorsed by Inkeep.
