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
| Drafts | `drafts/` (`service.ts`, `instances.ts`, `http.ts`, `remote.ts`), `github-pulls.ts` | Child processes from the shared pool (`process-pool/`), on Unix sockets (R5); `DraftRemote` is the host seam for reviews |
| Internal calls | `internal-request.ts` | Shared secret between a process and its drafts |
| People and identity | `people.ts`, `principal-directory.ts`, `board-identity.ts` | Person id `<host prefix><number>` from `host/names.ts`, `github-` on GitHub (R16) |
| Mentions, mail, chat | `mentions.ts`, `page-scan.ts`, `mention-mailer.ts`, `mail.ts`, `chat-notifier.ts` | Read marks in `mentions.json` |
| Settings | `personal-settings.ts`, `settings-admin.ts`, `workspace.ts` | |
| App, server calls | `packages/app/src/lib/client-fetch.ts` (`apiOrigin`), `packages/app/src/editor/DocumentContext.tsx` (`storageNamespace`) | Prefix and per-wiki storage (block 3) |
| Live-editing address | `packages/server/src/collab-bootstrap-url.ts` | Built from the Host header, plus the forwarded prefix behind the front door (block 1) |

Modules added by the branch are listed here by the pull request that adds them.

| Added | Module | Notes |
| --- | --- | --- |
| Stage 0 | `.github/workflows/prototypes.yml`, `.github/prototypes/` | Forgejo 15 in a container, the prototype front door (`front-proxy.mjs`) and the P and F rows; throwaway code kept as the base of H5. Not part of the product |
| Stage 1 (H1, H3) | `host/types.ts` | **Contract.** The host interface: `DoorHost` (sign-in, `access`, `accessByBot` with `refused:token` (401), `refused:not-admin` (403), `refused:removed` (bot no longer reaches the repo) and `unreachable`, async `tokenFor`), `HostNames` (label, id prefix, no-reply email) |
| Stage 1 | `host/github.ts` | The GitHub door host: authorize address, code exchange, `GET /user`, repo `permissions`, collaborator permission with the app token. Moved from `access-gate.ts` and `agent-access.ts` unchanged |
| Stage 1 | `host/names.ts` | `GITQUIRE_HOST` (only `github` in stage 1), `GITQUIRE_COMMIT_EMAIL_FORMAT`; the process's host names, read by `noreplyEmail` and `principalIdForUser` |
| Block 1 | `request-person.ts` | **Contract.** "Who is this request" (R2): `createRequestPerson` gives `sessionUser`, `isAdminRequest` and `agentOwner` for pages, live editing, assistants and the two global hooks. Behind the front door (`GITQUIRE_BEHIND_FRONT_DOOR`) only the forwarded person (`x-gitquire-principal`) with its per-wiki admin flag `repoAdmin` (R3), and only with the internal secret; otherwise today's session cookie and forwarded user. Also the internal headers `x-gitquire-prefix` (address prefix) and `x-gitquire-view` (open draft, request and response), trusted only with the secret and only behind the front door. The mode is read once, from the environment the gate is created with; the gate binds the prefix to the request (`requestPrefix`), which `/api/config` reads for the live-editing address |
| Block 1 | `behind-front-door-gate.ts` | The gate behind the front door: 403 without the internal secret for everything but `/healthz` and `/readyz`, HTTP and upgrades (R4); no sign-in routes, no cookies, `/auth/me` from the forwarded person; health checks only at their exact raw path, and 400 for a request or upgrade whose raw path touches `/collab` and differs from the normalised one; no agent tokens, agent pages or OAuth server |
| Block 1 | `drafts/http.ts`, `process-pool/forward.ts` (was `drafts/proxy.ts`), `principal-directory.ts` | Behind the front door: drafts read and hand back the open draft by header, keep the prefix in redirects, and pass the secret, person and prefix on browser and upgrade hops; live-editing auth hands every header, not only the cookie, to the resolvers |
| Block 2 | `process-pool/pool.ts` | The shared pool of child processes, moved out of `drafts/instances.ts`: one child per id, each on `<private dir>/<id>.sock` (`mkdtemp`, mode 0700; the id is checked so it cannot leave the folder), `PORT` removed from the child's environment, readiness and "pushed and clean" asked over the socket, `SIGTERM` then `SIGKILL` after the grace, idle sweep, `stopAll` waits for every child (R5, R6) |
| Block 2 | `process-pool/forward.ts` | HTTP and upgrade forwarding to a child's socket (moved from `drafts/proxy.ts`); strips the internal headers a browser could send |
| Block 2 | `process-pool/socket-listener.ts`, `boot.ts` | `GITQUIRE_SOCKET`: the server also listens on that Unix socket (mode 0600) with the primary server's handlers and binds its TCP listener to a kernel-chosen port; a socket peer counts as loopback for the ingress checks. The container's public port stays TCP |
| Block 2 | `process-pool/stop-state.ts` | `GET /api/gitquire/stop-state`, internal only: working tree clean, `HEAD` pushed, every running draft pushed and clean (R6) |
| Block 2 | `server-factory.ts` (`pushBeforeStop`), `boot.ts` | On stop, after the last write to disk: one push cycle, bounded (15 s), only with `autoSync.mode: full` and a remote; turned on behind the front door. Before that, `boot.ts` stops the drafts and waits for them (R6) |
| Stage 1 | `host/data-folder.ts` | Refuses a data folder recorded for another host, or used by GitHub people when the host is not GitHub; writes nothing for GitHub. Cannot see ids in comment threads committed to the repo |

## Contract files

Sent through `[[related.rules]]` in `.github/ai-review.toml` when a path they govern changes:

- `packages/server/src/gitquire/host/types.ts` (stage 1), for changes under `host/`, to `access-gate.ts`, `agent-access.ts`, `github-app.ts`, `github-pulls.ts` and `drafts/remote.ts`.

- `packages/server/src/gitquire/request-person.ts` (block 1), for changes to `access-gate.ts`, `behind-front-door-gate.ts`, `internal-request.ts`, `principal-directory.ts`, `settings-admin.ts`, `collab-bootstrap-url.ts` and `drafts/http.ts` and `process-pool/forward.ts`.

Planned: the front door's access check (block 5).

## Seams where a mistake leaks or loses work

| Seam | What can go wrong | Requirement |
| --- | --- | --- |
| Header carrying the person from front door to editor process to draft | Trusted without the internal secret; dropped by the forwarding code | R2, R4 |
| Address translation (prefix, `Location`, cookie `Path`, `Referer` catch-all for images) | A request without a wiki in its address lands in the wrong wiki | P1, block 3 |
| Browser storage and tab session | Offline edits of one wiki replayed into another | P2, block 3 |
| Process pool and sockets | Traffic of one wiki handed to another process; a socket outside the private folder | R5 |
| Stopping a wiki or the container | Unpushed commits lost; a stop that does not wait for its drafts or cuts the final push short | R6 |
| Access re-check | "Unknown" or "refused" read as "allowed"; one denial revokes everything | R8, R9, R14, R15 |
| Host token handed to an editor process | A process gets a token for other repos | R12 |
| Folder and id keys | A rename or a second host orphans a folder or mixes ids | R10, R16 |
| Adding a wiki | A repo under an owner that is not allowed becomes a running wiki | R1, R18 |

## Requirements in one line

R1 nothing written into a repo not turned on · R2 one "who is this request", passed on every hop · R3 admin flag per wiki · R4 internal secret required behind the front door · R5 Unix sockets · R6 stop only when pushed and clean · R7 allowed-users and MCP token refused in several-wiki mode · R8 live connections re-checked on a timer · R9 agent tokens revoked only with no wiki left · R10 folders keyed by host and repo id · R11 uninstalled or bot removed means "disconnected", never deleted · R12 host credentials only in the front door · R13 one writer for agent tokens · R14 host unreachable (network, 5xx): inside stay, nobody new · R15 own token refused (401, 403): wiki disconnected · R16 host in every record and id, addresses looked up · R17 Forgejo version and bot admin checked at start · R18 only allowed owners' repos run as wikis, checked in the front door.
