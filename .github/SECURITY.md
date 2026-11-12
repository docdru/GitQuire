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

**In scope:** the GitQuire server and web app in this repository, including GitHub sign-in and
session handling, GitHub App token handling, repository sync, the branch and pull request API,
discussions stored in pages, and the Docker image.

**Out of scope:** vulnerabilities in third-party dependencies (please report those upstream),
issues in OpenKnowledge that GitQuire does not change (please report those to
[OpenKnowledge](https://github.com/inkeep/open-knowledge/security/advisories/new)), deployments
that expose the server without sign-in (`GITQUIRE_AUTH=off`) to untrusted networks, and findings
that need physical access to a compromised machine or social engineering.
