# Plan: one front door for several Git hosts (`hosts-one-door`)

Copied on 2026-11-24 from the project doc "GitQuire plan: mentions in pages, then one front door for several Git hosts" (written from `main` at `6cabbd6`). Part A of that doc (mentions in pages) is pull request #238 against `main` and is not part of this branch. Findings of the run are at the end and are added in the pull request that makes them.

## Decided by the owner (2026-11-24)

| Question | Decision |
| --- | --- |
| Same person with a GitHub and a Forgejo account | **Two sign-ins, one session.** No linking. Settings, mention inbox and AI tokens stay per account |
| Wiki addresses | **Always with the host: `/w/<host key>/<owner>/<repo>/`**, on every server, also with one host. Clear and consistent. Old addresses without the host keep working by redirect. Where space is tight the UI shortens the name from the left with "…" |
| How many hosts | **A list of hosts**; tested and promised only for GitHub plus one Forgejo |
| Working mode | As before: continue without waiting; only the owner merges into `main` |

## Goal

Today a server has one host (`GITQUIRE_HOST`), and GitHub and Forgejo run side by side only as two containers. The goal: **one container and one address serve wikis from GitHub and from Forgejo**, and a person signs in with either or both.

### What already helps

- Wiki folders and keys are `<host>-<repository id>` (`front-door/wiki-table.ts`), person ids carry a host prefix (`host/names.ts`), and the front door finds a wiki by looking the address up in its table, never by parsing it (R16).
- Each wiki has its own editor process, which only ever sees one host. **Editor processes stay one-host**; the change is in the front door.

## Design

1. **Host key.** Every configured host has a key. The first host of each kind keeps today's value (`github`, `forgejo`), so existing folders, ids and tokens stay valid without any move. A further host of the same kind needs its own key (lowercase letters, digits, dashes). Everything that is keyed by the kind today (wiki key, person id prefix, token stores, pinned owner ids, admin and allowed-owner lists, the data-folder host record) is keyed by the host key.
2. **Settings.** Today's variables keep describing the first host and keep their meaning; a server with one host must behave exactly as `main` does now. Further hosts are added as a list. Proposed shape, change it if a better one shows and record why: `GITQUIRE_HOSTS=<key>,<key>` and per key `GITQUIRE_HOST_<KEY>_KIND`, `_URL`, `_API_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN` (Forgejo) or `_APP_ID` and `_APP_PRIVATE_KEY_FILE` (GitHub), `_ALLOWED_OWNERS`, `_ADMINS`, each secret also as `_FILE`.
3. **Sign-in and session.** The sign-in page shows one button per host. The session holds at most one account per host. The wiki menu offers "Sign in with <other host>" and signing out of one account or of all. The existing callback addresses stay for the first hosts (the OAuth applications are registered with them); further hosts get `/auth/<key>/…`.
4. **Access.** A request for a wiki is checked with the session's account **of that wiki's host**, and that account is the person forwarded to the editor process. The server-administrator flag belongs to an account on one host. The periodic re-check runs per account; losing access on one host cuts off only that host's wikis.
5. **Wiki list and Add a wiki.** The list shows the wikis of all signed-in accounts, each with its host label. Add a wiki first asks for the host (among those signed in), then works as today for that kind.
6. **Addresses (owner's decision): always with the host.** Every wiki's address is `/w/<host key>/<owner>/<repo>/`, on every server, including one with a single host. The wiki record stores its address, and the front door still finds a wiki by looking the address up in its table.
   - **Old addresses keep working:** `/w/<owner>/<repo>/…` redirects to the new address of the wiki that held it (page, API and image addresses alike, so saved links, bookmarks and images in pages do not break). After a clash exists, an old address that fits two wikis goes to the one that held it first. Look the three-part form up first, so an owner named like a host key cannot be misread.
   - **Names follow the address everywhere:** the wiki list, the wiki menu, the header, mails and chat messages, and `list_wikis` on `/mcp` show `<host key>/<owner>/<repo>` (the host also as its label or icon where there is room). The `wiki` argument still accepts the old `owner/repo` while it fits exactly one wiki, so existing prompts keep working.
   - **Tight space:** the UI shortens the name from the left with "…" (the repository name stays readable, for example `…/team/handbook`) and shows the full name on hover or tap. Never shorten in addresses, in `/mcp` answers or in mails.
7. **AI assistants.** Agent tokens and connector sign-ins belong to one account on one host and reach only that host's wikis (owner's decision: per account). With more than one host, the connector sign-in asks which host. Known limit, to document: a person with both accounts needs two connections.
8. **Mention badge.** The number is the sum over the signed-in accounts; the per-wiki counts stay.
9. **Moving over.** A volume from a one-host front door starts unchanged, and adding a second host needs no data move. `gitquire wikis adopt` keeps working for the first host.

## Requirements (each one is a leak or a bug otherwise)

| # | Requirement |
| --- | --- |
| S1 | People are never matched across hosts, neither by login nor by number. `alice` on GitHub and `alice` on Forgejo are two people everywhere: access, admin flag, settings, read marks, agent tokens, commit authors |
| S2 | Admin and allowed-owner lists are per host. The unqualified `GITQUIRE_ADMINS` and `GITQUIRE_ALLOWED_OWNERS` apply to the first host only |
| S3 | No hint across hosts: a person not signed in on a wiki's host, or without access, gets exactly the answer for an unknown address (page, API, websocket, `/mcp`) |
| S4 | A secret of one host is never sent to another host's address: sign-in codes and tokens, the GitHub App key, bot tokens, per-wiki tokens |
| S5 | The sign-in state binds the callback to the host that started it; a callback for another host is refused |
| S6 | The session cookie with two accounts stays within cookie size limits, and an expired or removed account drops out without ending the other |
| S7 | One host being down leaves the other host's wikis and sign-in working (today's host-down rules, per host) |
| S8 | With one host configured, behaviour is exactly today's, with one intended exception: addresses and wiki names carry the host, and the old ones redirect or are still accepted. Any other difference is a finding |
| S9 | The front door no longer reads the process-wide host names (`host/names.ts`) for anything that depends on the wiki or the account; it passes the host explicitly. Editor processes may keep the process-wide value |

## Blocks

| # | Block | Notes |
| --- | --- | --- |
| B0 | Branch set-up | Branch `hosts-one-door` from `main`; this plan copied to `plans/one-front-door.md`; `plans/review-map.md` and `.github/ai-review.toml` point to it; pull requests into the branch get the full CI |
| B1 | Host list in settings (contract) | Host key, the list, per-host lists; one host unchanged (S8). Independent agent review |
| B2 | Front door without the process-wide host (S9) | No behaviour change; the door holds one host object per key |
| B3 | Session with several accounts, sign-in page, sign-out (S5, S6) | Independent agent review |
| B4 | Access, re-check, admin flag per account (S1–S4, S7) | Independent agent review |
| B5 | Wiki list, Add a wiki with a host choice, addresses always with the host, redirects from old addresses, names shortened from the left in the UI | Browser storage and the tab key are per wiki address today: make sure a person's stored state survives the address change, or say what is lost |
| B6 | `/mcp`, agent tokens, connector sign-in per account; mention badge | |
| B7 | Tests against real services | A CI job like `forgejo-h5` with one front door, the real Forgejo 15 and the GitHub fake: both sign-ins in one session, both lists, same login on both hosts as two people, the same owner and repository name on both hosts, an old address redirecting (page, API, image), admin on one host only, access removed on one host, one host down, tokens per account, and the one-host rows unchanged |
| B8 | Docs | DEPLOY.md "Two Git hosts on one server", docs site, Connect AI text, known limits |
| B9 | Final pull request against `main` | Independent whole-branch review posted on it; branch handling removed again before it |

## Not included

Linking accounts into one person; one AI connection for both accounts; GitLab; a promise for Gitea or Codeberg; more than "GitHub plus one Forgejo" as a tested combination.

## Merge and review rules

- AI review runs on every pull request; answer every finding. Blocks marked above also get a separate agent that has not seen the work.
- The agent merges pull requests **into the feature branch** when `ci-ok` is green and the reviews are answered. **Only the owner merges into `main`.**
- If something decided here turns out impossible or unsafe, record it below, take the more conservative option that keeps S1–S9, and continue. Stop only if a requirement cannot be met at all.
- Say for every result what was really run (unit, fake, real Forgejo in CI) and what was not. GitHub has so far only been tried against a fake.

## Findings and decisions on the branch

### B0 (branch set-up)

- Pull requests against `hosts-one-door` and pushes to it run the full CI, Docker included, the same handling `wikis-hosts` had (#185, removed in #236); a push publishes `ghcr.io/docdru/gitquire:hosts-one-door`. The `forgejo-h5` workflow runs on pushes to the branch. B9 removes this again.

### B1 (host list in settings)

- **Settings shape (changed from the proposal, and why):** `GITQUIRE_HOSTS` lists only the **further** hosts; the first host stays described by today's variables (`GITQUIRE_HOST`, `GITQUIRE_HOST_URL`, `GITHUB_APP_*`, `GITQUIRE_ALLOWED_OWNERS`, `GITQUIRE_ADMINS`, …) and its key is its kind. Listing the first host again would give two names for one setting. Per further host: `GITQUIRE_HOST_<KEY>_KIND` (may be left out when the key is `github` or `forgejo`), `_LABEL`, `_URL`, `_API_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN` (Forgejo), `_APP_ID` and `_APP_PRIVATE_KEY_FILE` (GitHub), `_ALLOWED_OWNERS` (required), `_ADMINS`, `_COMMIT_EMAIL_FORMAT`; secrets also as `_FILE`.
- **Collisions:** `GITQUIRE_HOST_<KEY>_…` shares its prefix with the first host's `GITQUIRE_HOST_URL`, `_API_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN`, `_REPO_TOKEN`. A key whose first part is `url`, `api`, `client`, `token`, `repo` or `key` is refused, and so are two keys that would share a variable (`a` and `a-api` both give `GITQUIRE_HOST_A_API_URL`).
- A key `github` or `forgejo` must be of that kind. Labels: `GitHub`, `Forgejo`; a second host of a kind gets `Forgejo (<key>)` unless `_LABEL` is set; two equal labels are refused.
- Person ids are `<key>-<number>`; the first host's key is its kind, so its ids stay `github-`/`forgejo-`. Ids are never parsed by prefix, and keys are prefix-free anyway: a key that begins with another key or a kind followed by `-` (`lab` and `lab-2`, `github-x`) is refused (S1).
- Also refused (independent review of #240): the same Git server configured twice (equal web or API origin, the first host included), keys that are words under `/auth/` (`agents`, `logout`, `me`, `login`, `callback`, `add-wiki`, `w`), addresses with a user, query or `#`. A further GitHub host with its own `_URL` and no `_API_URL` gets `<url>/api/v3`, not `api.github.com`, so a GitHub Enterprise server's secrets never go to github.com (S4). The first host's `GITQUIRE_GITHUB_API_URL` still defaults to `api.github.com` independently, as on `main` (unchanged, S8).
- A single wiki (`GITQUIRE_WIKIS` off) refuses `GITQUIRE_HOSTS`, so nobody believes a second host is active when it is not.
- Not yet used: B1 only reads and checks the list; the front door still uses the first host until B2–B4.

### B2 (front door without the process-wide host)

- The front door holds one entry per host (`front-door/door-hosts.ts`) and no longer calls `setHostNames`. Code shared with the single wiki (`oauth-server.ts`, `agent-pages.ts`, `mentions.ts`) takes the label, sign-in path and own person id as optional arguments and keeps the process-wide value when called without them, so a single wiki is unchanged.
- A record without `hostKey` belongs to the host keyed by its kind; one with `hostKey` to that host. If no host with that key and the record's kind is configured (a host taken out of the settings), the wiki is closed for everybody and answers like an unknown address.
- Editor processes stay one-host; a process for a further host is told its host through its environment (`GITQUIRE_HOST`, addresses, admins, e-mail format, `GITQUIRE_HOST_KEY`, `GITQUIRE_HOST_LABEL`).
- Allowed-owner pins of further hosts are kept in `wikis.json` under `hostOwners`; the first host's stay under `owners`, so a one-host table file is written exactly as before.

### B3 (session with several accounts)

- One cookie, one account per host key, each with its own expiry, so one account can expire or be signed out while the other stays (S6). With only the first host's account the cookie keeps today's format; with two it is a compact list (about 400 bytes for two ordinary accounts; the test with 500-character names and avatar addresses stays under 3800 bytes because those two fields are trimmed in the list form).
- The OAuth state cookie names the host; a callback at another host's address is refused like an expired sign-in and logged (S5). A state cookie from before the update has no host and counts as the first host's.
- With several hosts, a person who is not signed in goes to `/auth/sign-in`, which offers every host; `/auth/logout` offers "Sign out of <host>" per account and "Sign out of all". With one host, sign-in still starts at the host right away and `/auth/sign-in` does not exist (S8).
- The wiki menu's "Sign in with <other host>" comes in B5 together with the other app changes.
- Independent review of #242: each account in the cookie carries an 8-character fingerprint of its host (kind and web origin), so moving a key to another server, or making another host the first, drops the account instead of reading `github-11` as `forgejo-11` (S1). A one-host cookie from before the update has no fingerprint and is read as the first host's until it expires (at most `GITQUIRE_SESSION_DAYS`); new one-host cookies carry it as an extra field `h`, which `main` ignores. The cookie size is enforced: names and avatar addresses are shortened, then emptied, until the cookie fits in 3800 bytes (tested with CJK names, control characters and three hosts). Each further host has its own state cookie (`gq_oauth_state_<key>`), so sign-ins started in two tabs at two hosts do not spoil each other; the first host keeps `gq_oauth_state`.

