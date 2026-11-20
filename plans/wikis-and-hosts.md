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
| R15 | When GitQuire's own token is refused for a wiki, the wiki is "disconnected": administrators see why, nobody new is let in, open sessions end at the next re-check. On Forgejo (stage 0): 401 = token revoked, 403 = bot not repo admin, 404 on the wiki's own repo = bot removed or repo gone (`repoById` tells which); only network errors and 5xx are "unreachable" (R14) | Otherwise a removed bot or a bot without admin rights silently disables every access re-check |
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
| Door | `signIn` | OAuth of the App | OAuth2 application; authorize with `response_type=code` and `scope=read:user read:repository`, exchange with `grant_type=authorization_code` (stage 0); use the token once, never store it |
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

Run on 2026-11-20 by `.github/workflows/prototypes.yml` on GitHub Actions: Forgejo **15.0.12** in a container, GitQuire's image built from `wikis-hosts` (`main` at `d5bf867`), headless Chromium. The scripts are in `.github/prototypes/`. Everything below was run for real except P5. Two runs gave the same answers; numbers are from the last.

### Verdict per row

| # | Result | In one line |
| --- | --- | --- |
| P1 | **pass**, with a prototype front door | Sign-in, an uploaded image, live editing in two tabs, entering, editing and leaving a draft all work under `/w/team/wiki/`. What it took is listed under "Addresses" |
| P2 | **pass** | An offline edit in wiki A did not reach wiki B, and reached A when A was reopened; B never showed A's page |
| P3 | **pass** (written down) | `docker stop` ends GitQuire in 0.4 s with exit 0 and no last commit or push; edits stay on the volume uncommitted |
| P4 | **pass** (numbers) | Start to `/readyz` 0.85–1.7 s; one idle editor process 184 MB RSS, container 132 MiB |
| P5 | **prepared, not tried** | `.github/prototypes/P5.md` and `p5-mcp.mjs` for the owner. Until then the `wiki` argument is unconfirmed |
| F1 | **pass**, with three changes for H2 | Sign-in works with scope `read:user read:repository`; the second redirect is silent |
| F2 | **pass** | The bot token works as the Git password with any user name, `x-access-token` included |
| F3 | **pass** | Pull request, squash merge with title, close, branch delete through the API |
| F4 | **pass** | Writer bot: 403. Admin bot: 200 with `none`, `write` or `admin`; unknown login 404 |
| F5 | **fail** | A repository-limited token cannot ask for another person's permission (403), so it cannot do the R15 re-check |
| F6 | **pass** | A commit with `<login>@<NO_REPLY_ADDRESS>` is linked to the account and shows its avatar |
| F7 | **pass**, one note | Comment threads render as footnotes with the thread as a list; Mermaid and math are marked for the browser to draw; display math loses `\,` |
| F8 | **pass**, fallback needed | A team-only member passes the sign-in check and the bot re-check, but is **not** in the collaborators list |
| F9 | **pass** | Removed bot: 404 on the repo and the permission call, Git "Repository not found". Revoked token: 401 everywhere. Both distinct from "unreachable" |

**Gate: F5 fails its "passes when", so by the plan's rule the run stops after stage 0.** The plan already accepts one unlimited bot token per server ("Known limits"), so F5 does not break M1's design; what it removes is the later option of one repository-limited token per wiki, and the analysis' recommended Forgejo set-up. The owner decides whether to continue.

### Forgejo (F rows, R10, R17, R18)

- **Version:** `GET /api/v1/version` → `15.0.12+gitea-1.22.0`. R17 must parse the leading number, not compare strings.
- **OAuth scopes are enforced** (the Forgejo documentation the analysis quoted says otherwise). With no scope the token is unlimited (it could create a repo); with `read:user` the repo check answers 403; with `read:user read:repository` the token can read the person and the repo's `permissions` and nothing more (repo create 403). GitQuire must ask for `read:user read:repository`. A team-only member of an organisation passes with the same scope.
- **Sign-in differences from GitHub, all found by running today's code against Forgejo (P1):** the authorize address needs `response_type=code` (otherwise "Only code response type is supported"); the code exchange needs `grant_type=authorization_code` (GitQuire sends a JSON body without it and gets no token); GitQuire sends no `scope`. With these three added by the prototype, today's `access-gate.ts` signs a person in through Forgejo unchanged: `GET /api/v1/user` and `GET /api/v1/repos/{o}/{r}` answer in GitHub's shape, `Bearer` and `token` both work. The first sign-in shows a consent page; the second redirect for an approved application is silent (303 with a code), so Add a wiki can reuse it.
- **Identity in today's code on Forgejo:** `/auth/me` gives `"email": "2+bob@users.noreply.github.com"` (the GitHub form) and `avatarUrl` on Forgejo. H3's per-host no-reply form is needed; Forgejo links `bob@noreply.example.org` (F6).
- **Git:** basic auth with the token as password, any user name. Today's header form works unchanged.
- **Drafts:** `POST /pulls` 201; the `head` filter on the list is **ignored** (filter in GitQuire, as planned); squash with `MergeTitleField` sets the commit title; `PATCH state=closed` 201; branch `DELETE` 204. A conflicting pull request reads `mergeable: false` and merging answers **405** "Please try again later"; merging an already merged one also answers **405**. The status alone cannot tell the two apart: read `merged` and `mergeable` first.
- **Re-checks (F4, F9 → R15):** bot as writer: 403 on `collaborators/{u}/permission` (the analysis' risk is real; the bot must be admin). As admin: 200 `none`/`write`/`admin`, 404 for an unknown login. Bot removed from the repo: 404 on the repo and the permission call. Token revoked: 401. No token: 404. So for GitQuire's own token, 401 = token refused, 403 = bot not admin, 404 on its own wiki = bot removed (or repo gone; `repoById` tells which), network error or 5xx = unreachable.
- **Repository-limited token (F5):** created with `repositories: [{owner, name}]`. On its repo: Git, list and create pull requests work; the permission call answers **403** although the bot is repo admin (the same call with the bot's unlimited credentials: 200). On another repo the bot can reach: Git refused, file contents 403, pull request create 404, but `GET /repos/{o}/{r}` **200** (metadata still readable).
- **R10, R18:** the repo record carries `owner.id` (organisation `team` → 7) and `id`; `GET /repositories/{id}` returns the repo.
- **People (F8):** the collaborators list holds direct collaborators only (`alice`, `bob`, the bot), not team members. `people.ts`' merge of "people who have signed in" is required on Forgejo.
- **Rendering (F7):** footnote mark `<sup id="fnref:user-content-c-7f3a">`, thread at the end as a list with mentions linked; `language-mermaid` and `language-math` with `is-loading` (drawn by Forgejo's browser code); task box; `[[Meeting notes]]` becomes a link. In `$$ … $$` the `\,` is eaten by Markdown escaping (`x,dx`).

### Addresses (P1, P2) — what the front door must do

The prototype (`front-proxy.mjs`) strips `/w/<owner>/<repo>/`, adds it to `Location`, and injected a small script that adds the prefix to the app's `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` and `sendBeacon` calls (standing in for block 3).

- **The page's Content-Security-Policy blocks inline scripts** (`script-src 'self'` plus hashes). Anything the front door adds to the page must be a same-origin file, or better, the app's own code (block 3).
- **Sign-in:** the callback address is built as `new URL('/auth/github/callback', externalUrl)`, which drops the prefix, and the state cookie is checked there. Behind a prefix this only works if sign-in happens at the root, which is the plan's front door; the prototype routed the callback by a cookie and kept the sign-in cookies at `/`.
- **Images escape the prefix.** An upload answers `src: "dot.png"`; under `/w/team/wiki/` the editor loads it as `/dot.png`. The `Referer` catch-all routed it to the right wiki, but it loaded only once the session was readable at `/`. A per-wiki cookie path (`Path=/w/<o>/<r>/`) is not enough; **the session must be the front door's, at the root**, with the person passed on (R2). The prototype emulated that by renaming each wiki's cookies (`gq_session__w_team_wiki`) at `/`.
- **Draft cookie** `gq_view` needs the same treatment (renamed per wiki in the prototype); the draft then opened, took an edit that stayed out of the live file, and closed.
- **Requests that arrived without a prefix in the final run:** only the sign-in callback and `GET /dot.png` (by `Referer`). With the script shim, no `POST`, WebSocket or API call escaped; without it (CSP) every API call did.
- **Browser storage (P2):** IndexedDB names already carry a per-project id (`ok-ydoc:main:<uuid>:index`), so offline edits did not cross over. `localStorage` keys are per origin and shared by all wikis: `ok-editor-tabs-v1:http://127.0.0.1:9000`, `ok-last-observed-branch`, `ok-doc-lineage-epochs`. B did not show A's tab in this run; block 3's `storageNamespace` must still cover these keys.

### Stopping and size (P3, P4)

- `docker stop` (10 s grace) ended both servers in 0.38 s, exit 0. Edits typed in the last two minutes were on the volume but **not committed**; nothing of the live edits reached Forgejo during the run (sync reported `lastPushOk` with `ahead: 0`). The draft branch had been pushed when the draft was created; its working copy was on the drafts volume. Nothing that reached the disk was lost. R6 needs "commit and push, then stop", and a `stop_grace_period` that leaves time for it.
- Start to `/readyz`: 1.1–1.7 s on a fresh volume, 0.85–1.2 s on a restart. Memory 20 s after start, nobody connected: main process 181–187 MB RSS, container 130–135 MiB. A page in use or a draft adds to that; not measured.

### Changes to the plan from stage 0

1. H2: authorize with `response_type=code` and `scope=read:user read:repository`; exchange with `grant_type=authorization_code`. Harmless for GitHub, which ignores both.
2. H2: tell a conflict from "already merged" by reading the pull request, not by the 405.
3. H3: the commit email in `/auth/me` and in commits must use the host's no-reply form.
4. R15 mapping as above (401, 403, 404, network or 5xx).
5. Block 1/5: sign-in, the session and the draft-view cookie live at the root in the front door; editor processes set no cookies of their own.
6. Block 3: the prefix comes from the app's code, not an injected script; `localStorage` keys get the wiki namespace.
7. R6: commit and push before stopping.
8. Forgejo set-up docs (H6): the bot needs an unlimited `write:repository` token and repo admin; repository-limited tokens cannot do the access re-check (F5).
