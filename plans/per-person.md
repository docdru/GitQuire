# Per-person data at the front door, mention mail from the account

The owner's plan is the project doc `claude/gitquire-plan-per-person-data-and-mail.md` (written 2026-11-24 from `main` at `12dea0d`). This file holds the plan's requirements in short, the stage 0 findings, the design as built, and the choices made on the owner's behalf. Pull requests go into the feature branch `per-person`; the owner merges `per-person` into `main`.

## Requirements (from the plan)

| # | Requirement |
| --- | --- |
| P1 | A person's address is shown only to that person: not in Git, logs (login only), `/mcp` answers, other people's API answers or other people's mails |
| P2 | Mail goes only to an address the host reports as verified, or one confirmed by code; never to an unverified or no-reply address |
| P3 | A mention of a wiki is mailed only to a person who can open that wiki at that moment; if the host cannot be asked, nothing is mailed and nothing is marked as mailed (one host down does not hold up the other host's mail) |
| P4 | Nothing is mailed twice across the move, and nothing that existed before a person switched mail on is mailed |
| P5 | Accounts on two hosts are never matched, also with the same address; each has its own switch, limits and "since" |
| P6 | Every per-person file has exactly one writer, the front door |
| P7 | The switch is off for everyone who had no confirmed address before; reading the account address sends nothing |
| P8 | An AI key is given only to the editor process serving a request of its owner, never placed in an environment, never written unsealed, never returned to the browser after saving |
| P9 | A person without access to a wiki learns nothing about it from mail, counts or the Settings page |
| P10 | The limits hold for the whole server; a restart may reset the counters, but not "mailed" |
| P11 | When the account address changes or disappears on the host, the old one is not used after the next sign-in; with none left, mail stops and Settings says why |
| P12 | Draft processes behave as today: these routes are answered for the live wiki |

## Stage 0 findings (B0)

### Readers and writers today

| Data | File | Readers | Writers |
| --- | --- | --- | --- |
| Mention mail address, pending code, "since", "last seen", mailed ids, confirmation stamps, per-recipient stamps | `<wiki>/.gitquire/local/gitquire/mentions.json` | editor `routes.ts` (email routes, inbox, mailer through `mention-mailer.ts`); front door `mention-counts.ts` (read ids only, for the badge) | editor `routes.ts` through `createMentionReadStore` (cached in memory per process) |
| Read ids | same file | editor inbox, mailer; front door badge | editor `markRead` |
| Confirmation-code key | `<wiki>/.gitquire/local/gitquire/mail-code-key` or `GITQUIRE_SESSION_SECRET` | editor | editor |
| Personal settings (YAML) | `<wiki>/.gitquire/local/gitquire/users/<id>.yml` | editor `/api/gitquire/me/settings` only; nothing else on the server reads the YAML | editor |
| "Put my AI assistant's edits into a draft" | `agentModes` in the wiki's drafts store (`drafts/store.ts`) | `drafts/http.ts`: `/api/gitquire/drafts/agent-mode`, and the default for MCP edit calls without a `workspace` argument | `drafts/http.ts` |
| AI keys | `<wiki>/.gitquire/local/gitquire/ai-keys/<id>.json`, AES-GCM with a key from `GITQUIRE_CHAT_KEY_SECRET` (per wiki, derived in `wiki-processes.ts`) | `chat/routes.ts` (`info`, `get`) | `chat/routes.ts` (`set`, `remove`); `move-over.ts` re-seals on adopt and unadopt |
| AI token usage | `<wiki>/.gitquire/local/gitquire/chat-usage/<id>.json` (`chat/usage.ts`), entries carry the chat id and title | `chat/routes.ts` usage report | `chat/routes.ts` after each answer; purge timer |
| AI chats | `<wiki>/.gitquire/local/gitquire/chats` | editor | editor (stay per wiki) |

Ids in all these files are the host's numeric account id; an editor process has one host, so the number is unique inside it.

### The sign-in token

- The front door gets the person's token in `completeLogin` (`front-door/server.ts`) and uses it for `access.signIn` and the Add-a-wiki list, then drops it. It is not in the session cookie and not kept in memory. **So the account address is read at sign-in only**, and the docs say so. P11 holds "after the next sign-in". This replaces the roadmap's "and from time to time".
- The single-wiki server (`access-gate.ts`) does the same with its own sign-in.

### Account addresses on the hosts

- **GitHub** (`GET /user/emails`): works with GitHub App user access tokens when the App has the account permission "Email addresses" (read); fields `email`, `primary`, `verified`, `visibility`. Without the permission GitHub answers 403 ("Resource not accessible by integration"); a person who has not yet approved a newly added permission gets the same. Checked against GitHub's REST documentation; tried only against the fake (`.github/prototypes/github-fake.mjs` gains `/user/emails`, with a switch for the 403).
- **Forgejo 15** (`GET /api/v1/user/emails`, scope `read:user`, already asked for at sign-in): probed for real in the `forgejo-h5` job by `.github/prototypes/pp_emails.py` (step "Per-person stage 0"): an admin-created account, a second address added by the person, a token without `read:user`, and an account attached to an OAuth2 source (the closest the job gets to an account made by SSO; a real SSO sign-in through an outside provider was not made). The results are in the job log under `[PP0]` and are copied below once the job ran.
- An address is used only when the host marks it both primary and verified; GitHub's `@users.noreply.github.com` and Forgejo's no-reply domain are skipped.

### The door socket

`front-door/token-socket.ts` is a small HTTP server on a 0600 Unix socket. A caller proves which wiki it is with the per-process secret header. It can carry more paths; it has no notion of a person. Behind the front door, the person of a request comes from the forwarded principal header, trusted because of the same per-process secret.

### What breaks the plan's design, and the change

Nothing makes the design impossible. Three details change:

1. **No token after sign-in** (above): the address is read at sign-in only.
2. **Which person an editor may ask about (P8):** the per-process secret proves the wiki, not the person. The front door therefore adds a **person ticket** to every request it forwards to an editor process (pages, API, websocket and `/mcp`): an HMAC, with a front-door-only random key, over the wiki key, the person id and an expiry of 15 minutes. The editor passes the ticket back on its door-socket questions; the front door answers only for the ticket's person and only to the process of the ticket's wiki. An editor process cannot ask for anyone whose request it has not served in the last 15 minutes.
3. **Token usage names chats:** usage entries carry chat titles, which are wiki content. Per person, the usage report shows totals and days over all wikis of the account, and the list of chats only for the wiki it is asked in (entries carry the wiki key). So a person who lost access to a wiki does not keep seeing its chat titles (P9).

## Design as built

- **Store:** `people-store.ts`. One folder per person, `<root>/<person id>/`, files 0600, folder 0700. Behind the front door the root is `/data/server/people/`; a single wiki without a front door uses `<wiki>/.gitquire/local/gitquire/people/` (same code). Person ids are the ones used everywhere (`github-123`, `forgejo-7`, `<host key>-<number>` for further hosts), so two hosts never share a folder (P5). Server-wide mail counters live in memory; the per-recipient confirmation stamps live in `<root>/../mail-recipients.json`.
- **One writer (P6):** only the front door process opens the store for writing. Editor processes behind the front door never open it; they ask over the door socket with the person ticket.
- The rest is filled in block by block below.

## Choices made on the owner's behalf

Each is also in the roadmap doc's "Assumptions".

- **B0:** the address is read at sign-in only (finding 1).
- **B0:** the person ticket (finding 2), 15 minutes, HMAC-SHA256 with a random key made at each front-door start. It carries the login too, and the front door answers a ticket only while the person can still open that wiki (the same access answer as for pages), so removing someone's access stops the answers at once, not after 15 minutes (B1 review).
- **B1:** per-person questions are asked only while serving an HTTP request (pages, API, `/mcp`), each of which carries a fresh ticket. The live-editing websocket gets a ticket at its start, but nothing asks per-person questions from it; a long-open socket would otherwise hold an expired ticket (B1 review).
- **B0:** usage report as in finding 3.
- **B0:** "Put my AI assistant's edits into a draft" counts as a personal setting and moves to the per-person store (plan item 7). It becomes one choice for all wikis of the account.

- **B2:** if the host cannot be asked at a sign-in, the last verified account address stays in use for up to 30 days after it was last read; after that it is no longer offered or used, and Settings says the host could not be asked. A changed or vanished address is taken over at the next sign-in that reaches the host (P11). (B2 review.)
- **B2:** a GitHub 403 that is a rate limit counts as "could not ask", not as a missing permission.
- **B2:** the no-reply domain on Forgejo is taken from the commit-email format (`GITQUIRE_COMMIT_EMAIL_FORMAT`, by default `{login}@noreply.<host>`); DEPLOY.md says to set it to Forgejo's `NO_REPLY_ADDRESS`. An account address on that domain is not offered. On Forgejo, "verified" means what Forgejo reports as activated; on a Forgejo that does not ask people to confirm addresses, every added address counts as verified (P2 as written: "what the host reports").

- **B4:** the mailer asks each wiki's access for a person with a 15-second deadline; no answer in time counts as "could not ask" (P3). The front door's badge now also counts draft review requests, like the in-wiki inbox.
- **B5:** every 10 minutes the front door runs `git ls-remote` for each sleeping wiki's branch with the wiki's own token and compares it with the wiki's `@{upstream}`; if the host has more, it starts the wiki process, which pulls and goes back to sleep by the usual idle rule (30 minutes). After a failed check the wiki is asked again after 10, 20, 40 … minutes, at most every 2 hours; a successful check resets that. A running wiki is not asked (it pulls by itself).

- **B6:** the front door answers `/api/gitquire/me/settings` and `/api/gitquire/drafts/agent-mode` itself. For "Put my AI assistant's edits into a draft", the front door sends the person's choice with every `/mcp` call that names no workspace (as the same header a `workspace` argument sets), so the editor process never reads a per-person file; behind the front door the editor answers both routes with 404. The person-socket questions of B1 for settings stay available but nothing in the server needs them: stage 0 found no other server-side reader of the personal settings YAML.

## Blocks

| Block | Pull request | State |
| --- | --- | --- |
| B0 | — | this file |
