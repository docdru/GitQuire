# Review map for the `wikis-hosts` branch

One page for reviewers: who owns what, the requirements in one line each, and the seams where a mistake leaks one wiki into another or loses work. Updated in the pull request that changes what it describes. The plan is `plans/wikis-and-hosts.md`.

## Switches

`GITQUIRE_WIKIS` off and `GITQUIRE_HOST` unset must behave exactly as `main`. Any code path that runs with both off and differs from `main` is a finding.

## Who owns what

All paths under `packages/server/src/gitquire/` unless stated.

| Area | Module | Notes |
| --- | --- | --- |
| Start-up, content folder set-up | `index.ts`, `agents-file.ts`, `legacy-data-folder.ts` | Writes `AGENTS.md` and `.gitquire/` into the folder it starts on (R1) |
| Sign-in, session cookie, access check | `access-gate.ts`, `signed-cookie.ts`, `github-auth-config.ts` | GitHub OAuth, `GET /user`, repo `permissions`; one admin flag per cookie (R3) |
| GitQuire's own token on the host | `github-app.ts`, `repo-bootstrap.ts` | App JWT, installation token, basic auth `x-access-token` for Git |
| Agent tokens and `/mcp` sign-in | `agent-tokens.ts`, `agent-access.ts`, `oauth-server.ts`, `agent-pages.ts` | Re-check by collaborator permission; one revocation revokes all (R9, R13) |
| Drafts | `drafts/` (`service.ts`, `instances.ts`, `proxy.ts`, `http.ts`, `remote.ts`), `github-pulls.ts` | Child processes on free ports (R5); `DraftRemote` is the host seam for reviews |
| Internal calls | `internal-request.ts` | Shared secret between a process and its drafts |
| People and identity | `people.ts`, `principal-directory.ts`, `board-identity.ts` | Person id `github-<number>` (R16) |
| Mentions, mail, chat | `mentions.ts`, `page-scan.ts`, `mention-mailer.ts`, `mail.ts`, `chat-notifier.ts` | Read marks in `mentions.json` |
| Settings | `personal-settings.ts`, `settings-admin.ts`, `workspace.ts` | |
| App, server calls | `packages/app/src/lib/client-fetch.ts` (`apiOrigin`), `packages/app/src/editor/DocumentContext.tsx` (`storageNamespace`) | Prefix and per-wiki storage (block 3) |
| Live-editing address | `packages/server/src/collab-bootstrap-url.ts` | Built from the Host header |

Modules added by the branch are listed here by the pull request that adds them.

| Added | Module | Notes |
| --- | --- | --- |
| Stage 0 | `.github/workflows/prototypes.yml`, `.github/prototypes/` | Forgejo 15 in a container, the prototype front door (`front-proxy.mjs`) and the P and F rows; throwaway code kept as the base of H5. Not part of the product |

## Contract files

Sent with every review as reference docs (later as `[[related.rules]]`): none yet. Planned: the host interface types (stage 1), the "who is this request" function (block 1), the front door's access check (block 5).

## Seams where a mistake leaks or loses work

| Seam | What can go wrong | Requirement |
| --- | --- | --- |
| Header carrying the person from front door to editor process to draft | Trusted without the internal secret; dropped by the forwarding code | R2, R4 |
| Address translation (prefix, `Location`, cookie `Path`, `Referer` catch-all for images) | A request without a wiki in its address lands in the wrong wiki | P1, block 3 |
| Browser storage and tab session | Offline edits of one wiki replayed into another | P2, block 3 |
| Process pool and sockets | Traffic of one wiki handed to another process | R5 |
| Stopping a wiki or the container | Unpushed commits lost | R6 |
| Access re-check | "Unknown" or "refused" read as "allowed"; one denial revokes everything | R8, R9, R14, R15 |
| Host token handed to an editor process | A process gets a token for other repos | R12 |
| Folder and id keys | A rename or a second host orphans a folder or mixes ids | R10, R16 |
| Adding a wiki | A repo under an owner that is not allowed becomes a running wiki | R1, R18 |

## Requirements in one line

R1 nothing written into a repo not turned on · R2 one "who is this request", passed on every hop · R3 admin flag per wiki · R4 internal secret required behind the front door · R5 Unix sockets · R6 stop only when pushed and clean · R7 allowed-users and MCP token refused in several-wiki mode · R8 live connections re-checked on a timer · R9 agent tokens revoked only with no wiki left · R10 folders keyed by host and repo id · R11 uninstalled or bot removed means "disconnected", never deleted · R12 host credentials only in the front door · R13 one writer for agent tokens · R14 host unreachable (network, 5xx): inside stay, nobody new · R15 own token refused (401, 403): wiki disconnected · R16 host in every record and id, addresses looked up · R17 Forgejo version and bot admin checked at start · R18 only allowed owners' repos run as wikis, checked in the front door.
