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
| Stage 2 (H5) | `prototypes.yml` job `forgejo-h5`, `.github/prototypes/h5_forgejo.py` | GitQuire's image against Forgejo 15 over https with a test authority: R17 start check, sign-in, sync both ways, a draft from start to publish, access removed, host down. Runs on pull requests that touch GitQuire's server code, Docker or the workflow, and on pushes to `wikis-hosts`. Not part of `ci-ok` |
| Stage 1 (H1, H3) | `host/types.ts` | **Contract.** The host interface: `DoorHost` (sign-in, `access`, `accessByBot` with `refused:token` (401), `refused:not-admin` (403), `refused:removed` (bot no longer reaches the repo) and `unreachable`, async `tokenFor`), `HostNames` (label, id prefix, no-reply email) |
| Stage 4 (block 4) | `host/types.ts` | Adds to `DoorHost`: `addableRepos(personToken)` (`listed` with owner and repo ids, `refused` with whose token, `unreachable`; `blocked: 'bot-not-admin'` on Forgejo), `repoById(id)` (`found` with a `HostRepoRecord` carrying host, ids and current names, `gone`, `refused`, `unreachable`), `health(repo)` (`ok`, `unreachable`, `refused:*`). `gone` means "not found with GitQuire's own credentials": deleted, or the app or bot no longer on the repo; a private repo does not tell which |
| Stage 4 | `host/github.ts` | With `app` (a JWT source) given (block 5: a repo record with an `id` is minted for and checked through `/repositories/{id}` with `repository_ids`, so a reused old name gets nothing; 429 and rate-limited 403 answers are `unreachable`, never `refused:not-admin`): `tokenFor` mints a token limited to the one repo through `GET /repos/{o}/{r}/installation`, cached per repo and renewed 10 minutes before expiry; `accessByBot` and `health` use it; `repoById` finds the installation by minting with `repository_ids` (metadata only). Without `app`, as before: the one installation token. `addableRepos` uses the person's token only. Never returns the JWT or the key |
| Stage 4 | `host/forgejo.ts` | `repoTokens` store (the front door implements it): `tokenFor` returns the wiki's own limited token and refuses to return the unlimited bot token; `addableRepos` pages `GET /user/repos`, keeps admin repos the bot reaches (`GET /repositories/{id}` with the bot token); `repoById`; `health` from the bot (401, 403/404, not admin) and the limited token. A token limited to another repo reads this repo's record (F5) without `push`, so `health` answers `refused:token` for it (seen in `forgejo-h5`) |
| Stage 4 | `host/renames.ts` | Pure `repoChange(stored, repoById answer)`: `same`, `renamed`, `moved` (owner id changed: re-check allowed owners, R18), `mismatch`, or the answer passed on |
| Stage 4 | `.github/prototypes/h5_door.mjs`, `h5_forgejo.py door` | Runs the Forgejo door functions above, from the TypeScript source, against the `forgejo-h5` Forgejo |
| Stage 1 | `host/github.ts` | The GitHub door host: authorize address, code exchange, `GET /user`, repo `permissions`, collaborator permission with the app token. Moved from `access-gate.ts` and `agent-access.ts` unchanged |
| Stage 1 | `host/names.ts` | `GITQUIRE_HOST` (only `github` in stage 1), `GITQUIRE_COMMIT_EMAIL_FORMAT`; the process's host names, read by `noreplyEmail` and `principalIdForUser` |
| Stage 2 (H2) | `host/forgejo.ts` | The Forgejo door host: sign-in with `response_type=code`, scope `read:user read:repository`, `grant_type`; access re-check with the **unlimited** bot token (404 then asks whether the bot still reaches the repo: `refused:removed`); `tokenFor` returns only the **repository-limited** token; `selfCheck` (version 15+, bot is repo admin, limited token can write; R17) |
| Stage 2 | `host/forgejo-repo.ts` | `GITQUIRE_HOST_*` settings and both tokens; the repo client for bootstrap and sync (limited token only, `https://` only) |
| Stage 2 | `forgejo-pulls.ts` | Drafts on Forgejo: pull requests, squash merge with title and the 405 retry (F10), branches by API, head filter done in GitQuire |
| Stage 2 | `drafts/instances.ts` | Draft processes no longer receive `GITQUIRE_HOST_TOKEN` or `GITQUIRE_HOST_TOKEN_FILE` (R12) |
| Block 1 | `request-person.ts` | **Contract.** "Who is this request" (R2): `createRequestPerson` gives `sessionUser`, `isAdminRequest` and `agentOwner` for pages, live editing, assistants and the two global hooks. Behind the front door (`GITQUIRE_BEHIND_FRONT_DOOR`) only the forwarded person (`x-gitquire-principal`) with its per-wiki admin flag `repoAdmin` (R3), and only with the internal secret; otherwise today's session cookie and forwarded user. Also the internal headers `x-gitquire-prefix` (address prefix) and `x-gitquire-view` (open draft, request and response), trusted only with the secret and only behind the front door. The mode is read once, from the environment the gate is created with; the gate binds the prefix to the request (`requestPrefix`), which `/api/config` reads for the live-editing address |
| Block 1 | `behind-front-door-gate.ts` | The gate behind the front door: 403 without the internal secret for everything but `/healthz` and `/readyz`, HTTP and upgrades (R4); no sign-in routes, no cookies, `/auth/me` from the forwarded person; health checks only at their exact raw path, and 400 for a request or upgrade whose raw path touches `/collab` and differs from the normalised one; no agent tokens, agent pages or OAuth server |
| Block 1 | `drafts/http.ts`, `process-pool/forward.ts` (was `drafts/proxy.ts`), `principal-directory.ts` | Behind the front door: drafts read and hand back the open draft by header, keep the prefix in redirects, and pass the secret, person and prefix on browser and upgrade hops; live-editing auth hands every header, not only the cookie, to the resolvers |
| Block 2 | `process-pool/pool.ts` | The shared pool of child processes, moved out of `drafts/instances.ts`: one child per id, each on `<private dir>/<id>.sock` (`mkdtemp`, mode 0700; the id is checked so it cannot leave the folder), `PORT` removed from the child's environment, readiness and "pushed and clean" asked over the socket, `SIGTERM` then `SIGKILL` after the grace, idle sweep; the socket folder is made on the first start and removed by `stopAll` and at exit; once stopping, new starts are refused and `stopAll` waits for starts and queued work, then for every child (R5, R6) |
| Block 2 | `process-pool/forward.ts` | HTTP and upgrade forwarding to a child's socket (moved from `drafts/proxy.ts`); strips the internal headers a browser could send |
| Block 2 | `process-pool/socket-listener.ts`, `boot.ts` | `GITQUIRE_SOCKET`: the server also listens on that Unix socket (mode 0600) with the primary server's handlers and binds its TCP listener to a kernel-chosen port; a socket peer counts as loopback for the ingress checks. The container's public port stays TCP |
| Block 2 | `chat/routes.ts` | The AI chat's tools call back on the server's own TCP port when the chat came in over the Unix socket (`req.socket.localPort` is undefined there) |
| Block 2 | `process-pool/stop-state.ts` | `GET /api/gitquire/stop-state`, internal only: working tree clean, `HEAD` pushed, every running draft pushed and clean (R6) |
| Block 2 | `server-factory.ts` (`pushBeforeStop`), `sync-engine.ts` (`pushForStop`), `boot.ts` | On stop, after the last write to disk: wait for a sync cycle in flight, then one push cycle, only with `autoSync.mode: full` and a remote; "pushed" only if the tree is clean and `HEAD` is not ahead afterwards. Behind the front door only, within one stop deadline (`GITQUIRE_STOP_DEADLINE_MS`, 50 s; drafts get 25 s and a 30 s grace): the push gets what is left minus 5 s, at most 15 s. Before that, `boot.ts` stops the drafts and waits for them (R6) |
| Stage 1 | `host/data-folder.ts` | Refuses a data folder recorded for another host, or used by GitHub people when the host is not GitHub; writes nothing for GitHub. Cannot see ids in comment threads committed to the repo |
| Block 3 | `packages/app/src/lib/gitquire/wiki-prefix.ts` | The app's wiki prefix: `/w/<owner>/<repo>` when the page's path starts with `/w/<owner>/<repo>/`, otherwise none (`/`, `/docs/plan`, `/w/team` give none). Used by the fetch wrapper (`client-fetch.ts` `pathPrefix`: every same-origin address gets the prefix once), the live-editing fallback address (`cc1.ts`), app-built `/api/asset` addresses, Excalidraw's asset path and the Ask Claude wiki address; and as `storageNamespace` (`DocumentContext.tsx`), which scopes `ok-last-observed-branch`, `ok-doc-lineage-epochs` and the replay outbox, plus the tab session key `ok-editor-tabs-v1:<origin><prefix>`. No prefix: every address and key as before. The web manifest and the page's icon links are relative |
| Block 5 | `front-door/access.ts` | **Contract.** Who may open which wiki: at sign-in the person's token is asked for every wiki in the table in parallel (`signIn`), disconnected ones included, so their admins see them after a restart, the answer is kept 5 minutes, then re-asked with GitQuire's own token (`accessByBot`). `unreachable` keeps a person with a positive answer inside and lets nobody new in (R14); `refused:*` disconnects the wiki (R15); a disconnected wiki or one whose owner is not allowed opens for nobody (R18) and is listed only to people last seen as its admins and to server administrators. A changed answer calls `changed`, so the front door looks the repo up again by id. The admin flag is per wiki (R3) |
| Block 5 | `front-door/wiki-table.ts`, `allowed-owners.ts`, `repo-tokens.ts`, `settings.ts` | Wiki table `/data/server/wikis.json` (records keyed `<host>-<id>`, former names, state, never deleted; R10, R11, R16). Allowed owners pinned to the host's owner id at the first wiki under a listed name. Forgejo per-wiki tokens `/data/server/repo-tokens.json`, mode 0600. Settings refuse `GITQUIRE_ALLOWED_USERS`, `GITQUIRE_MCP_TOKEN` (R7) and a start without allowed owners or `GITQUIRE_REPO` (R18) |

## Contract files

Sent through `[[related.rules]]` in `.github/ai-review.toml` when a path they govern changes:

- `packages/server/src/gitquire/host/types.ts` (stage 1), for changes under `host/`, to `access-gate.ts`, `agent-access.ts`, `github-app.ts`, `github-pulls.ts` and `drafts/remote.ts`.

- `packages/server/src/gitquire/request-person.ts` (block 1), for changes to `access-gate.ts`, `behind-front-door-gate.ts`, `internal-request.ts`, `principal-directory.ts`, `settings-admin.ts`, `collab-bootstrap-url.ts` and `drafts/http.ts` and `process-pool/forward.ts`.

- `packages/server/src/gitquire/front-door/access.ts` (block 5), for changes under `front-door/`, to `door-token.ts` and to `process-pool/forward.ts`.

## Seams where a mistake leaks or loses work

| Seam | What can go wrong | Requirement |
| --- | --- | --- |
| Header carrying the person from front door to editor process to draft | Trusted without the internal secret; dropped by the forwarding code | R2, R4 |
| Address translation (prefix, `Location`, cookie `Path`, `Referer` catch-all for images) | A request without a wiki in its address lands in the wrong wiki | P1, block 3 |
| Browser storage and tab session | Offline edits of one wiki replayed into another | P2, block 3 |
| Process pool and sockets | Traffic of one wiki handed to another process; a socket outside the private folder | R5 |
| Stopping a wiki or the container | Unpushed commits lost; a stop that does not wait for its drafts or cuts the final push short | R6 |
| Access re-check | "Unknown" or "refused" read as "allowed"; one denial revokes everything | R8, R9, R14, R15 |
| Host token handed to an editor process | A process gets a token for other repos; `tokenFor` returns the Forgejo bot token or anything but a one-repo token | R12 |
| Folder and id keys | A rename or a second host orphans a folder or mixes ids; `repoChange` reads an owner rename as a move or the reverse | R10, R16, R18 |
| Adding a wiki | A repo under an owner that is not allowed becomes a running wiki | R1, R18 |

## Requirements in one line

R1 nothing written into a repo not turned on · R2 one "who is this request", passed on every hop · R3 admin flag per wiki · R4 internal secret required behind the front door · R5 Unix sockets · R6 stop only when pushed and clean · R7 allowed-users and MCP token refused in several-wiki mode · R8 live connections re-checked on a timer · R9 agent tokens revoked only with no wiki left · R10 folders keyed by host and repo id · R11 uninstalled or bot removed means "disconnected", never deleted · R12 host credentials only in the front door · R13 one writer for agent tokens · R14 host unreachable (network, 5xx): inside stay, nobody new · R15 own token refused (401, 403): wiki disconnected · R16 host in every record and id, addresses looked up · R17 Forgejo version and bot admin checked at start · R18 only allowed owners' repos run as wikis, checked in the front door.
