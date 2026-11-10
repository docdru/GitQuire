# GitQuire

A collaborative, WYSIWYG Markdown wiki for small teams, with GitHub as the backend.

- **Write together.** A Notion-like editor with live cursors, for meetings and for async work.
- **Plain Markdown in Git.** Every page is a `.md` file in a GitHub repository. Edits are committed to `main` automatically after a short pause.
- **Branches and pull requests when you need them.** Propose a new report on a branch and open a PR from the editor.
- **Links that stay correct.** `[[wiki links]]`, backlinks, and links rewritten when a page is renamed.
- **Comments in the file.** Threads live in a hidden block at the end of each Markdown file, so everything stays in Git.
- **Self-hosted.** One Docker container with a `/data` volume.

> **Status:** early. GitQuire is being built in phases. Phase 1 (this repository today) packages the
> OpenKnowledge server as a Docker image with CI. GitHub sign-in, branches and PRs, shared comments,
> mobile polish and naming rules follow. See the [roadmap](#roadmap).

## Run it

```bash
docker run --rm -p 8080:8080 \
  -e OK_ALLOW_EXTERNAL=1 \
  -v gitquire-data:/data \
  ghcr.io/docdru/gitquire:latest
# then open http://localhost:8080
```

Behind a real domain, also set `OK_EXTERNAL_URL=https://your.domain`. Run exactly one container per
volume: the collaboration server is single-writer. Health checks: `GET /healthz` and `GET /readyz`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `OK_BIND` | `0.0.0.0` | Bind address |
| `OK_ALLOW_EXTERNAL` | unset | Must be `1` to accept non-local connections |
| `OK_EXTERNAL_URL` | unset | Public origin, required behind a domain or proxy |
| `GITQUIRE_GIT_NAME`, `GITQUIRE_GIT_EMAIL` | `GitQuire`, `gitquire@localhost` | Git identity for commits until per-user sign-in lands |

Build the image yourself:

```bash
docker build -t gitquire:local .
```

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
