import type { IncomingMessage, ServerResponse } from 'node:http';
import { type RelationLink, relationLinks } from '@gitquire/core/gitquire/typed-links';
import type { GateLogger, SessionUser } from './access-gate.ts';
import {
  actionItemStatePath,
  combinedMentionIndex,
  createActionItemMentions,
  WRITER_WINDOW_MS,
} from './action-item-mentions.ts';
import type { AccessVerdict } from './agent-access.ts';
import {
  type ChatPost,
  chatStatePath,
  createChatNotifier,
  resolveChatConfig,
} from './chat-notifier.ts';
import { GitHubUnavailableError } from './github-app.ts';
import { parseGitHubRepo } from './github-auth-config.ts';
import { type GitHubPullsClient, GitHubRequestError } from './github-pulls.ts';
import { parseHostKind } from './host/names.ts';
import { type MailConfig, type MailMessage, resolveMailConfig, sendMail } from './mail.ts';
import {
  buildInbox,
  createMentionReadStore,
  type Mention,
  mentionIndexFrom,
  mentionStatePath,
  mentionsFor,
  mentionsInMarkdown,
} from './mentions.ts';
import { mergedGoneBranches } from './merged-branches.ts';
import { namingRuleFromEnv } from './naming.ts';
import { listPageMentions, type PageMentions, pageMentionsIn } from './page-mentions.ts';
import { createObjectListCache, type PageFacts, pageFacts } from './page-objects.ts';
import { createPageScan, docNameForPath, type ScanFilter, type ScannedPage } from './page-scan.ts';
import { createSingleWikiPeople, type SingleWikiPeople } from './people/single-wiki.ts';
import { allowedLoginsFrom, createPeopleDirectory, peopleStatePath } from './people.ts';
import { recentDocumentWriter } from './principal-directory.ts';
import { type RunGit, runGitSync } from './repo-bootstrap.ts';
import { behindFrontDoorFromEnv } from './request-person.ts';
import { createTypedLinkListCache } from './typed-links.ts';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 256;
const MAX_PR_BODY_LENGTH = 20_000;
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export interface GitQuireRoutesDeps {
  projectDir: string;
  log: GateLogger;
  pulls?: GitHubPullsClient;
  baseBranch?: string;
  sessionUser?: (req: IncomingMessage) => SessionUser | undefined;
  runGit?: RunGit;
  env?: Readonly<Record<string, string | undefined>>;
  mentionStateFile?: string;
  contentDir?: string;
  contentFilter?: () => ScanFilter | undefined;
  sendMail?: (config: MailConfig, message: MailMessage) => Promise<void>;
  mailRoundMs?: number;
  chatStateFile?: string;
  postToChat?: ChatPost;
  extraMentions?: () => Mention[];
  notify?: boolean;
  canOpen?: (login: string) => Promise<AccessVerdict>;
}

export interface GitQuireRoutes {
  recordAddress?: SingleWikiPeople['recordAddress'];
  peopleStore?: SingleWikiPeople['store'];
  handle: (req: IncomingMessage, res: ServerResponse) => boolean;
  mailRound: () => Promise<number>;
  chatRound: () => Promise<number>;
  stop: () => void;
}

const DEFAULT_MAIL_ROUND_MS = 60_000;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function repositoryFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { owner: string; name: string; url: string; host: string } | null {
  try {
    const repo = parseGitHubRepo(env.GITQUIRE_REPO);
    if (repo === undefined) return null;
    if (parseHostKind(env) === 'forgejo') {
      const web = (env.GITQUIRE_HOST_URL ?? '').trim().replace(/\/+$/, '');
      if (web === '') return null;
      return { ...repo, url: `${web}/${repo.owner}/${repo.name}`, host: 'Forgejo' };
    }
    return { ...repo, url: `https://github.com/${repo.owner}/${repo.name}`, host: 'GitHub' };
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body-too-large', 'Request too large.');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new HttpError(400, 'invalid-json', 'Body must be a JSON object.');
  }
  throw new HttpError(400, 'invalid-json', 'Body must be a JSON object.');
}

export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  try {
    return new URL(origin).host === (Array.isArray(host) ? host[0] : host);
  } catch {
    return false;
  }
}

export function validateBranchName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new HttpError(400, 'invalid-branch', 'Branch name is required.');
  }
  const trimmed = name.trim();
  if (
    !BRANCH_NAME_RE.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.includes('//') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('.lock') ||
    trimmed.includes('@{')
  ) {
    throw new HttpError(
      400,
      'invalid-branch',
      'Use letters, numbers, dots, dashes, underscores and slashes, e.g. report/q4-results.',
    );
  }
  return trimmed;
}

export function createGitQuireRoutes(deps: GitQuireRoutesDeps): GitQuireRoutes {
  const runGit = deps.runGit ?? runGitSync;
  const git = (args: readonly string[]): string => runGit(args, deps.projectDir);

  function currentBranch(): string | undefined {
    try {
      const name = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
      return name === '' ? undefined : name;
    } catch {
      return undefined;
    }
  }

  function refList(pattern: string, strip: string): string[] {
    return git(['for-each-ref', '--format=%(refname)', pattern])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(strip))
      .map((line) => line.slice(strip.length))
      .filter((name) => name !== '' && name !== 'HEAD')
      .sort((a, b) => a.localeCompare(b));
  }

  async function baseBranch(): Promise<string> {
    if (deps.baseBranch !== undefined) return deps.baseBranch;
    if (deps.pulls !== undefined) return deps.pulls.defaultBranch();
    return 'main';
  }

  async function removeMergedBranches(base: string, current: string | undefined) {
    const merged = await mergedGoneBranches(git, base, deps.pulls?.mergedPullHeads);
    for (const name of merged) {
      if (name === current) continue;
      try {
        git(['branch', '-D', name]);
        deps.log.info(
          { name },
          '[gitquire] removed a branch that was merged and deleted on GitHub',
        );
      } catch (err) {
        deps.log.warn({ err, name }, '[gitquire] could not remove a merged branch');
      }
    }
    return merged;
  }

  async function listBranches(res: ServerResponse): Promise<void> {
    const base = await baseBranch();
    const current = currentBranch();
    const merged = await removeMergedBranches(base, current);
    const local = refList('refs/heads', 'refs/heads/');
    const remote = refList('refs/remotes/origin', 'refs/remotes/origin/');
    sendJson(res, 200, {
      current: current ?? null,
      base,
      local,
      remoteOnly: remote.filter((name) => !local.includes(name)),
      github: deps.pulls !== undefined,
      currentMerged: current !== undefined && merged.includes(current),
    });
  }

  async function createBranch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const name = validateBranchName(body.name);
    const existing = refList('refs/heads', 'refs/heads/');
    if (existing.includes(name)) {
      throw new HttpError(409, 'branch-exists', `A branch named ${name} already exists.`);
    }
    const from = body.from === undefined ? 'HEAD' : validateBranchName(body.from);
    const startPoint =
      from === 'HEAD' || existing.includes(from) ? from : `refs/remotes/origin/${from}`;
    try {
      git(['branch', '--no-track', name, startPoint]);
    } catch (err) {
      if (refList('refs/heads', 'refs/heads/').includes(name)) {
        throw new HttpError(409, 'branch-exists', `A branch named ${name} already exists.`);
      }
      const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new HttpError(400, 'branch-create-failed', `Could not create ${name}: ${reason}`);
    }
    const user = deps.sessionUser?.(req);
    deps.log.info({ name, from, by: user?.login }, '[gitquire] created branch');
    sendJson(res, 201, { name, from });
  }

  function requirePulls(): GitHubPullsClient {
    if (deps.pulls === undefined) {
      throw new HttpError(
        501,
        'github-not-configured',
        'Pull requests need the GitHub App (GITHUB_APP_ID and its private key).',
      );
    }
    return deps.pulls;
  }

  async function listPulls(res: ServerResponse): Promise<void> {
    if (deps.pulls === undefined) {
      sendJson(res, 200, { configured: false, pulls: [] });
      return;
    }
    sendJson(res, 200, { configured: true, pulls: await deps.pulls.listOpenPullRequests() });
  }

  async function createPull(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pulls = requirePulls();
    const body = await readJson(req);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title === '' || title.length > MAX_TITLE_LENGTH) {
      throw new HttpError(400, 'invalid-title', 'A title of up to 256 characters is required.');
    }
    const description = typeof body.body === 'string' ? body.body : '';
    if (description.length > MAX_PR_BODY_LENGTH) {
      throw new HttpError(400, 'invalid-body', 'The description is too long.');
    }
    const head = currentBranch();
    if (head === undefined) {
      throw new HttpError(409, 'detached-head', 'The editor is not on a branch.');
    }
    const base = body.base === undefined ? await baseBranch() : validateBranchName(body.base);
    if (head === base) {
      throw new HttpError(
        409,
        'same-branch',
        `You are on ${base}. Create or switch to another branch first.`,
      );
    }
    if (!(await pulls.branchExists(head))) {
      throw new HttpError(
        409,
        'branch-not-pushed',
        `${head} is not on GitHub yet. Wait for the next sync, then try again.`,
      );
    }
    const user = deps.sessionUser?.(req);
    const attribution =
      user === undefined ? 'Opened from GitQuire.' : `Proposed by @${user.login} in GitQuire.`;
    const trimmed = description.trim();
    const pull = await pulls.createPullRequest({
      title,
      body: trimmed === '' ? attribution : `${trimmed}\n\n---\n${attribution}`,
      head,
      base,
      draft: body.draft === true,
    });
    deps.log.info({ number: pull.number, head, base, by: user?.login }, '[gitquire] opened PR');
    sendJson(res, 201, { pull });
  }

  function factsOrNone(path: string, markdown: string): PageFacts {
    try {
      return pageFacts(path, markdown);
    } catch (err) {
      deps.log.warn({ err, path }, '[gitquire] could not read the properties of a page');
      const docName = docNameForPath(path) ?? path;
      return { docName, title: docName, fields: {}, tasks: [], decisions: [], clipped: false };
    }
  }

  function relationsOrNone(path: string, markdown: string): RelationLink[] {
    try {
      return relationLinks(markdown);
    } catch (err) {
      deps.log.warn({ err, path }, '[gitquire] could not read the typed links of a page');
      return [];
    }
  }

  function pageMentionsOrNone(path: string, markdown: string): PageMentions {
    try {
      return pageMentionsIn(path, markdown);
    } catch (err) {
      deps.log.warn({ err, path }, '[gitquire] could not read the mentions of a page');
      return { mentions: [], clipped: false };
    }
  }

  const pageScan = createPageScan(
    deps.contentDir ?? deps.projectDir,
    (path, markdown) => ({
      mentions: mentionsInMarkdown(path, markdown),
      facts: factsOrNone(path, markdown),
      relations: relationsOrNone(path, markdown),
      pageMentions: pageMentionsOrNone(path, markdown),
    }),
    Date.now,
    deps.contentFilter,
  );
  const actionItemMentions = createActionItemMentions({
    stateFile: actionItemStatePath(deps.projectDir),
    pages: () => pageScan.all().map((page) => ({ path: page.path, facts: page.value.facts })),
    writerOf: (docName) => {
      const writer = recentDocumentWriter(docName, WRITER_WINDOW_MS);
      return writer === undefined
        ? undefined
        : { id: writer.id, login: writer.login, name: writer.name };
    },
    onError: (err) => deps.log.warn({ err }, '[gitquire] could not save action item mentions'),
  });
  const mentionIndex = combinedMentionIndex(
    mentionIndexFrom(pageScan, (page) => page.mentions),
    actionItemMentions,
    { all: () => deps.extraMentions?.() ?? [] },
  );
  const objectList = createObjectListCache();
  let factPages: { source: unknown; pages: ScannedPage<PageFacts>[] } | undefined;

  function listPageObjects(res: ServerResponse): void {
    const scanned = pageScan.all();
    if (factPages === undefined || factPages.source !== scanned) {
      const pages = scanned.map((page) => ({ ...page, value: page.value.facts }));
      factPages = { source: scanned, pages };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(objectList.body(factPages.pages));
  }

  function listPageMentionsOf(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://gitquire.invalid');
    const login = url.searchParams.get('login') ?? undefined;
    const pages = pageScan.all().map((page) => ({ ...page, value: page.value.pageMentions }));
    sendJson(res, 200, listPageMentions(pages, login === '' ? undefined : login));
  }

  const typedLinkList = createTypedLinkListCache();
  let relationPages: { source: unknown; pages: ScannedPage<RelationLink[]>[] } | undefined;

  function listTypedLinks(res: ServerResponse): void {
    const scanned = pageScan.all();
    if (relationPages === undefined || relationPages.source !== scanned) {
      const pages = scanned.map((page) => ({ ...page, value: page.value.relations }));
      relationPages = { source: scanned, pages };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(typedLinkList.body(relationPages.pages));
  }
  const people = createPeopleDirectory({
    stateFile: peopleStatePath(deps.projectDir),
    allowedLogins: allowedLoginsFrom(deps.env?.GITQUIRE_ALLOWED_USERS),
    ...(deps.pulls?.collaborators === undefined ? {} : { collaborators: deps.pulls.collaborators }),
    onError: (err) => deps.log.warn({ err }, '[gitquire] could not read or save the people list'),
  });

  async function listPeople(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = deps.sessionUser?.(req);
    if (user === undefined) {
      sendJson(res, 200, { people: [], me: null });
      return;
    }
    people.remember(user);
    sendJson(res, 200, { people: await people.list(), me: user.login });
  }

  const behindFrontDoor = behindFrontDoorFromEnv(deps.env ?? process.env);
  const mentionReads = createMentionReadStore(
    deps.mentionStateFile ?? mentionStatePath(deps.projectDir),
  );

  const mail = resolveMailConfig(deps.env ?? process.env);
  if (mail.kind === 'invalid') {
    deps.log.warn({ reason: mail.reason }, '[gitquire-mail] email for mentions is off');
  }
  const single = behindFrontDoor
    ? undefined
    : createSingleWikiPeople({
        projectDir: deps.projectDir,
        env: deps.env ?? process.env,
        log: deps.log,
        mail,
        send: deps.sendMail ?? sendMail,
        mentions: mentionIndex,
        readIds: (id) => mentionReads.readIds(id),
        sessionUser: (req) => deps.sessionUser?.(req),
        sameOrigin: isSameOrigin,
        ...(deps.canOpen === undefined ? {} : { canOpen: deps.canOpen }),
      });
  const mailer = single?.mailer;
  const chat = resolveChatConfig(deps.env ?? process.env);
  if (chat.kind === 'invalid') {
    deps.log.warn({ reason: chat.reason }, '[gitquire-chat] chat notifications are off');
  }
  const chatNotifier =
    chat.kind === 'on'
      ? createChatNotifier({
          index: mentionIndex,
          config: chat.config,
          stateFile: deps.chatStateFile ?? chatStatePath(deps.projectDir),
          post: deps.postToChat,
          log: deps.log,
        })
      : undefined;
  const rounds =
    deps.notify === false ? [] : [mailer, chatNotifier].filter((job) => job !== undefined);

  function startMailRounds(): NodeJS.Timeout | undefined {
    if (rounds.length === 0) return undefined;
    const timer = setInterval(() => {
      for (const job of rounds) job.round().catch(() => undefined);
    }, deps.mailRoundMs ?? DEFAULT_MAIL_ROUND_MS);
    timer.unref();
    return timer;
  }
  const mailTimer = startMailRounds();

  function listMentions(req: IncomingMessage, res: ServerResponse): void {
    const user = deps.sessionUser?.(req);
    if (user === undefined) {
      sendJson(res, 200, {
        enabled: false,
        login: null,
        unread: 0,
        mentions: [],
        email: { available: false, address: null, pending: null },
      });
      return;
    }
    people.remember(user);
    single?.seen(user);
    const inbox = buildInbox(user, mentionIndex.all(), mentionReads.readIds(user.id));
    sendJson(res, 200, {
      enabled: true,
      ...inbox,
    });
  }

  async function markMentionsRead(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = deps.sessionUser?.(req);
    if (user === undefined) {
      throw new HttpError(401, 'sign-in-required', 'Sign in to use the mention inbox.');
    }
    const body = await readJson(req);
    const all = mentionIndex.all();
    const mine = new Set(mentionsFor(user, all).map((mention) => mention.id));
    let ids: string[];
    if (body.all === true) {
      ids = [...mine];
    } else if (Array.isArray(body.ids) && body.ids.every((id) => typeof id === 'string')) {
      ids = body.ids as string[];
    } else {
      throw new HttpError(400, 'invalid-ids', 'Send "ids" as a list of mention ids, or "all".');
    }
    mentionReads.markRead(user.id, ids, mine);
    const inbox = buildInbox(user, all, mentionReads.readIds(user.id));
    sendJson(res, 200, { unread: inbox.unread });
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(req)) {
      throw new HttpError(403, 'cross-origin', 'Cross-origin requests are not allowed.');
    }
    if (path === '/api/gitquire/naming' && method === 'GET') {
      sendJson(res, 200, { rule: namingRuleFromEnv(deps.env) });
      return;
    }
    if (path === '/api/gitquire/repository' && method === 'GET') {
      sendJson(res, 200, { repository: repositoryFromEnv(deps.env ?? process.env) });
      return;
    }
    if (path === '/api/gitquire/branches' && method === 'GET') return listBranches(res);
    if (path === '/api/gitquire/branches' && method === 'POST') return createBranch(req, res);
    if (path === '/api/gitquire/pulls' && method === 'GET') return listPulls(res);
    if (path === '/api/gitquire/pulls' && method === 'POST') return createPull(req, res);
    if (path === '/api/gitquire/objects' && method === 'GET') return listPageObjects(res);
    if (path === '/api/gitquire/typed-links' && method === 'GET') return listTypedLinks(res);
    if (path === '/api/gitquire/mentions' && method === 'GET') return listMentions(req, res);
    if (path === '/api/gitquire/page-mentions' && method === 'GET') {
      return listPageMentionsOf(req, res);
    }
    if (path === '/api/gitquire/people' && method === 'GET') return listPeople(req, res);
    if (
      (path === '/api/gitquire/me/settings' ||
        path === '/api/gitquire/mentions/email' ||
        path === '/api/gitquire/mentions/email/confirm') &&
      single === undefined
    ) {
      throw new HttpError(404, 'served-by-front-door', 'The front door answers this.');
    }
    if (path === '/api/gitquire/mentions/read' && method === 'POST') {
      return markMentionsRead(req, res);
    }
    throw new HttpError(404, 'not-found', 'Unknown GitQuire endpoint.');
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = new URL(req.url ?? '/', 'http://gitquire.invalid').pathname;
    if (!path.startsWith('/api/gitquire/')) return false;
    if (single?.routes.handles(path, req.method ?? 'GET')) {
      single.routes.handle(req, res, single.who(req), path);
      return true;
    }
    route(req, res, path).catch((err: unknown) => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else if (err instanceof GitHubUnavailableError) {
        sendJson(res, 503, { error: 'github-unavailable', message: err.message });
      } else if (err instanceof GitHubRequestError) {
        sendJson(res, err.status === 422 ? 422 : 502, {
          error: 'github-request-failed',
          message: err.message,
        });
      } else {
        deps.log.error({ err, path }, '[gitquire] route failed');
        sendJson(res, 500, { error: 'internal', message: 'Internal error.' });
      }
    });
    return true;
  }

  return {
    handle,
    ...(single === undefined
      ? {}
      : { recordAddress: single.recordAddress, peopleStore: single.store }),
    mailRound: () => mailer?.round() ?? Promise.resolve(0),
    chatRound: () => chatNotifier?.round() ?? Promise.resolve(0),
    stop: () => clearInterval(mailTimer),
  };
}
