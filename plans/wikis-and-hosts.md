# Several wikis and other Git hosts — plan for the `wikis-hosts` branch

This is the working copy of the plan on the branch. The owner's copy is the project doc "GitQuire: several wikis and other Git hosts — combined plan" (2026-11-20); where the two source docs ("several wikis on one server — work plan" and "other Git hosts (Forgejo first) — analysis") differ from it, it wins. This file is removed or moved into the docs when the branch is merged into `main`.

## Result in short

- One sequence of about 12 working sessions with two usable milestones: **M1, one wiki on Forgejo** and **M2, several wikis on GitHub or Forgejo**.
- Built on the feature branch `wikis-hosts`. `main` stays untouched until the owner merges the branch. The agent merges into the branch itself, after CI and the reviews below.
- One run goes from the prototypes to M2 (stages 0 to 6). It stops early only when a prototype row fails.
- On Forgejo the bot must be **repo admin**, or GitQuire can never notice that someone lost access.
- One host per server at first; the data layout is host-qualified so several hosts stay possible later.
- Who may add a wiki is limited by **allowed owners**.

## The two switches

| Setting | Off (default) | On |
| --- | --- | --- |
| `GITQUIRE_WIKIS` | One wiki, exactly as on `main` | Several wikis behind a front door at `/w/<owner>/<repo>/` |
| `GITQUIRE_HOST` | Unset means GitHub, exactly as on `main` | `github` or `forgejo` |

With `GITQUIRE_WIKIS` off and `GITQUIRE_HOST` unset, GitQuire behaves exactly as on `main` after every pull request on the branch.

## Decided by the owner (2026-11-18 and 2026-11-20)

| Topic | Decision |
| --- | --- |
| Deployment | One container. No container per wiki, no subdomains |
| Separation | Everyone sees only their own wikis |
| Design | One front door plus one editor process per wiki |
| Addresses | `/w/<owner>/<repo>/`, translated centrally at the front door |
| Mentions | People are informed across all their wikis (badge) |
| Approval | No server-admin approval step |
| Who may add a wiki | **Allowed owners is the one mechanism.** Only repos under a listed owner (a user or organisation on the host) can become wikis. Any repo admin may add such a repo. If nothing is set, only the owner of the first wiki (`GITQUIRE_REPO`) is allowed |
| Who may sign in and edit | The Git host decides. A person sees a wiki only if they can write to its repo |
| Order | Host interface, then Forgejo for one wiki (M1), then several wikis for both hosts (M2) |
| GitQuire's identity on Forgejo | A bot account with an access token, added to each wiki repo as **admin** |
| Hosts supported | GitHub, Forgejo 15 or later. Gitea and Codeberg untested and unpromised. GitLab not planned. SSH transport dropped |
| Reviews | Every pull request gets the AI review action; the ones marked below also get a review by a separate agent |

Proposed and not objected to: a repo becomes a wiki only when a repo admin clicks **Make this a wiki**; one `/mcp` address and one connection per person, every tool names the wiki; personal settings, AI keys and AI chats are one per person across wikis; opening the server with several wikis shows the list.

## Requirements R1–R18

| # | Requirement | Why |
| --- | --- | --- |
| R1 | Nothing is written into a repo that was not turned on as a wiki | Starting a server on a folder initialises it and writes `AGENTS.md` (`gitquire/index.ts`) |
| R2 | One function answers "who is this request" for pages, live editing, assistants and the two global hooks; every hop passes the person on | Browser traffic to drafts re-reads the cookie, and the forwarding code removes the header (`access-gate.ts`, `drafts/proxy.ts`) |
| R3 | The admin flag is per wiki | The session cookie holds one flag for one repo |
| R4 | A process behind the front door refuses any request without the internal secret | Otherwise the cookie alone opens every wiki |
| R5 | Unix sockets, not guessed ports | Two pools picking free ports can hand one wiki's traffic to another process (`drafts/instances.ts`) |
| R6 | A wiki is stopped only when it reports "pushed and clean"; stopping waits for its drafts; `stop_grace_period` 60 s | Nothing pushes on stop today |
| R7 | `GITQUIRE_ALLOWED_USERS` and `GITQUIRE_MCP_TOKEN` are refused in several-wiki mode, with a clear message | Both skip the repo check and would open every wiki |
| R8 | Open live-editing connections are re-checked on a timer; a person is cut off within minutes of losing access | Connections are admitted once |
| R9 | Agent tokens are revoked only when the person has no wiki left | Today one "denied" revokes all (`agent-access.ts`) |
| R10 | Folders are keyed by **host and repo id** (`/data/wikis/<host>-<repo id>/`); names are addresses, with redirects after a rename | A rename would orphan the folder with unpushed edits |
| R11 | A wiki whose app was uninstalled, or whose bot was removed, stays visible to administrators as "disconnected" and is never deleted automatically | It may hold unpushed edits |
| R12 | Host credentials live only in the front door; an editor process gets a token for its own repo and the settings it needs, nothing else | All wikis share one container and user |
| R13 | The agent-token store has exactly one writer, the front door | It caches in memory (`agent-tokens.ts`) |
| R14 | If the host cannot be reached (network errors and 5xx only): people already inside stay, nobody new is let in | Today "unknown" counts as allowed |
| R15 | When GitQuire's own token is refused (401, 403) for a wiki, the wiki is "disconnected": administrators see why, nobody new is let in, open sessions end at the next re-check | Otherwise a removed bot or a bot without admin rights silently disables every access re-check |
| R16 | Every wiki record, folder and person id carries its host; addresses are looked up, not parsed | Keeps several hosts per server possible |
| R17 | On Forgejo the start fails with a clear message when the version is below the floor or the bot cannot ask for another person's permission | The permission endpoint is admin-only |
| R18 | A repo becomes or stays a running wiki only while its owner is allowed; the check is in the front door, not in the app | Without it anyone who can give GitQuire access to a repo can use the server, at about 250 MB per wiki in use |

## Allowed owners

| Point | How |
| --- | --- |
| Setting | `GITQUIRE_ALLOWED_OWNERS`, a list of owner names on the server's host. Empty means the owner of `GITQUIRE_REPO` |
| Start | In several-wiki mode with neither `GITQUIRE_ALLOWED_OWNERS` nor `GITQUIRE_REPO` set, GitQuire refuses to start and says which to set |
| Where it is enforced | In the front door, in **Make this a wiki** and again whenever a wiki's process is started. Owners are compared by the host's owner id where the host gives one |
| Add a wiki | Lists the person's repos under allowed owners that GitQuire can reach. Below the list: "This server hosts wikis from …". Opening the address of a repo under another owner shows the same sentence |
| Owner later removed from the list | Treated like R11: "disconnected", never deleted automatically |
| Repo moved to another owner | Re-checked through `repoById`; if the new owner is not allowed, as the row above |

## The host interface, split along the front door

| Side | Function | GitHub | Forgejo |
| --- | --- | --- | --- |
| Door | `signIn` | OAuth of the App | OAuth2 application; ask for the smallest scope, use the token once, never store it |
| Door | `access(personToken, repo)` → none, write, admin | `permissions` on the repo | Same; no "maintain" |
| Door | `accessByBot(login, repo)` → none, write, admin, refused, unreachable | Collaborator permission with the app token | Same call with the bot token; bot must be repo admin |
| Door | `addableRepos(personToken)` | Installations and their repos visible to the person | `GET /user/repos` of the person, kept where the person is admin and the bot has access |
| Door | `repoById(id)` with the owner's name and id | Repo number | Repo `id` |
| Door | `tokenFor(repo)` | Installation token limited to that repo, renewed hourly | The bot token |
| Door | `selfCheck()` at start and per wiki | App installed, contents permission | Version at least 15; bot is admin on the repo |
| Wiki | `repoInfo`, `people`, `reviews` (today's `DraftRemote`) | As today | Pull requests with squash; head-branch filter in GitQuire; branches through Git |
| Both | `names` | Label, id prefix `github-`, no-reply form | Label, id prefix `forgejo-`, no-reply form from a setting |

In single-wiki mode there is no front door; the one process uses both sides, as today.

## Order

| Stage | Content | Agent review |
| --- | --- | --- |
| – | Branch set-up (this file, the review map, CI and image for the branch) | |
| 0 | Prototypes P1–P5, F1–F9; findings appended below. Continue if every row passes | |
| 1 | H1 host interface, GitHub only, no change in behaviour; H3 id prefix, commit email format, refuse a data folder with another host's ids | yes |
| 2 | Forgejo, one wiki: H2 adapter with `selfCheck`, H4 wording, H5 tests with a Forgejo container in CI, H6 docs. **M1** | |
| 3 | Blocks 1–3: behind a proxy, process pool, app under a prefix | yes (1, 2) |
| 4 | Block 4 for both hosts: `addableRepos`, `repoById` and renames, bot removed or app uninstalled, `tokenFor` | |
| 5 | Blocks 5–8: front door, AI assistants, wiki list and menu, mention badge | yes (5, 6) |
| 6 | Blocks 10, 11: moving over and docs; two-wiki tests against Forgejo plus the GitHub fake. Final pull request to `main` opened, not merged. **M2** | yes (10) |

## Merge rule for the branch

The agent merges a pull request into `wikis-hosts` when `ci-ok` is green on the full set; the AI review has run and every P0 and P1 is fixed or answered in the pull request with a reason (a skipped review is stated and then needs the agent review); and, for pull requests marked for review, a separate agent that has not seen the work found no must-fix. The agent never merges into `main`.

## Known limits, accepted

- Forgejo: one bot token for all wikis, so the per-repo token protects GitHub servers only.
- Forgejo: the bot is repo admin, more than editing needs.
- Forgejo sign-in tokens are not limited; GitQuire uses the token once and drops it.
- One host call per wiki at sign-in; reconsider a list call above roughly 50 wikis.
- Inside an allowed owner, any repo admin may add a wiki.
- About 250 MB per wiki in use, and the same per draft in use.
- All wikis share one browser origin and one container user.

## Prototype findings

Appended by stage 0.
