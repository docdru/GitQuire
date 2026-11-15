# @inkeep/open-knowledge

[OpenKnowledge](https://openknowledge.ai) is a local-first, agent-friendly Markdown knowledge base with a rich editor. It is available as a desktop app for **macOS, Windows, and Linux**, or as the same local web app served from your terminal.

This package installs the cross-platform `ok` / `open-knowledge` CLI and bundles the web app. Use it on Linux, Windows, macOS, an Intel Mac, or a server. The macOS desktop app currently requires Apple silicon, so Intel Mac users should use this CLI and the web app.

## Install

```bash
npm install -g @inkeep/open-knowledge
```

Requires [Node.js 24+](https://nodejs.org) and Git.

To remove it from a project, delete the project's `.ok/` folder.

## Quick start

```bash
cd your-project
ok init          # scaffold .ok/
ok start         # serve the editor and open it in your browser
```

- `ok init` — turn a folder into an OpenKnowledge project.
- `ok start` — run the local server and web editor, then open it in your browser.
- `ok --help` — list every command.

## Desktop app

For the native desktop experience, [download OpenKnowledge](https://openknowledge.ai/download) for macOS, Windows, or Linux.

## Documentation

Full docs, integrations, and configuration: <https://openknowledge.ai/docs>.

- [CLI and web app guide](https://openknowledge.ai/docs/reference/cli)
- [Quickstart](https://openknowledge.ai/docs/get-started/quickstart)

## License

[GPL-3.0-or-later](https://github.com/inkeep/open-knowledge/blob/main/LICENSE).
