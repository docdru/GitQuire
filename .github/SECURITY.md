# Security Policy

GitQuire is a self-hosted, collaborative Markdown editor. A GitQuire server signs people in with
GitHub, holds a GitHub App private key, reads and writes a Git working copy, and pushes to GitHub.
We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[Private Vulnerability Reporting](https://github.com/docdru/GitQuire/security/advisories/new),
the "Report a vulnerability" button on the repository's **Security** tab. This opens a
confidential channel with the maintainers.

We aim to acknowledge reports within a few days and will keep you updated on the fix. Please give
us a reasonable window to ship a fix before any public disclosure.

## Supported versions

GitQuire is pre-1.0. Only the latest image published from `main`
(`ghcr.io/docdru/gitquire:latest`) receives security fixes. Please reproduce on it before reporting.

## Scope

**In scope:** the code that ships in the GitQuire Docker image, including the parts that came from
OpenKnowledge: the server and web app, GitHub sign-in and session handling, GitHub App token
handling, repository sync, drafts, comments stored in pages, the MCP endpoint, the AI chat, the
`ok` CLI commands the image runs, and the image itself. If the same problem also exists in
OpenKnowledge, we tell Inkeep privately through their
[security advisories](https://github.com/inkeep/open-knowledge/security/advisories/new) and
coordinate before publishing the fix.

**Out of scope:** the desktop app, which GitQuire does not ship, and `ok` CLI commands the image
does not run (the image runs `ok start`, `ok init` and `ok gitquire-bootstrap`); behaviour
documented as a known limitation in [DEPLOY.md](../DEPLOY.md) (for example what the opt-in AI chat
can reach); vulnerabilities in third-party dependencies (please report those to the
dependency's maintainers; tell us if GitQuire needs an upgrade); deployments
that expose the server without sign-in (`GITQUIRE_AUTH=off`) to untrusted networks, and findings
that need physical access to a compromised machine or social engineering.
