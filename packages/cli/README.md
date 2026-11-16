# @gitquire/cli

The GitQuire command line: the self-hosted server and the web app GitQuire serves, plus commands for working on a project (`init`, `sync`, `lint`, `comments convert`, …). It installs two names for the same command, `gq` and `gitquire`. The old names `ok` and `open-knowledge` still work for now and print a notice.

This package is not published to npm. It ships inside GitQuire's Docker image (`ghcr.io/docdru/gitquire`); see [DEPLOY.md](https://github.com/docdru/GitQuire/blob/main/DEPLOY.md).

## Install from a checkout

```bash
git clone https://github.com/docdru/GitQuire.git
cd GitQuire
pnpm install
pnpm exec turbo run build --filter=@gitquire/cli
cd packages/cli && pnpm pack && npm install -g ./gitquire-cli-*.tgz
```

Requires [Node.js 24+](https://nodejs.org), pnpm and Git.

To remove GitQuire from a project, delete the project's `.ok/` folder.

## Quick start

```bash
cd your-project
gq init          # scaffold .ok/
gq start         # serve the editor and open it in your browser
```

- `gq init` — turn a folder into a GitQuire project.
- `gq start` — run the local server and web editor, then open it in your browser.
- `gq --help` — list every command.

## Documentation

<https://docdru.github.io/GitQuire/docs>, in particular the [CLI and web app guide](https://docdru.github.io/GitQuire/docs/reference/cli).

## License

[GPL-3.0-or-later](https://github.com/docdru/GitQuire/blob/main/LICENSE). GitQuire started as a fork of [OpenKnowledge](https://github.com/inkeep/open-knowledge) by Inkeep, Inc.
