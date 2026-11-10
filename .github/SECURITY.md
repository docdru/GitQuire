# Security Policy

Open Knowledge is a local-first desktop and CLI application that reads and writes files on your machine, stores credentials in your OS keyring, and can sync with GitHub. We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's [Private Vulnerability Reporting](https://github.com/inkeep/open-knowledge/security/advisories/new) — the "Report a vulnerability" button on the repository's **Security** tab. This opens a confidential channel with the maintainers.

We aim to acknowledge new reports within 3 business days and will keep you updated on remediation. Please give us a reasonable window to ship a fix before any public disclosure.

## Supported versions

Open Knowledge is pre-1.0 and ships frequent releases. Only the **latest stable release** receives security fixes. Please reproduce on the latest version before reporting.

## Scope

**In scope:** the desktop app, local server, CLI, GitHub-sync credential handling, and the MCP server in this repository.

**Out of scope:** the marketing website, vulnerabilities in third-party dependencies (please report those upstream), and findings that require physical access to an already-compromised machine or social engineering.
