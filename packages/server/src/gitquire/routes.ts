import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GateLogger, SessionUser } from './access-gate.ts';
import { GitHubUnavailableError } from './github-app.ts';
import { type GitHubPullsClient, GitHubRequestError } from './github-pulls.ts';
import {
  isAllowedRecipient,
  isEmailAddress,
  type MailConfig,
  type MailMessage,
  resolveMailConfig,
  sendMail,
} from './mail.ts';
import { createMentionMailer } from './mention-mailer.ts';
import {
  buildInbox,
  createMentionIndex,
  createMentionReadStore,
  mentionStatePath,
  mentionsFor,
} from './mentions.ts';
import { namingRuleFromEnv } from './naming.ts';
import { type RunGit, runGitSync } from './repo-bootstrap.ts';

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
  sendMail?: (config: MailConfig, message: MailMessage) => Promise<void>;
  mailRoundMs?: number;
}

export interface GitQuireRoutes {
  handle: (req: IncomingMessage, res: ServerResponse) => boolean;
  mailRound: () => Promise<number>;
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

  async function listBranches(res: ServerResponse): Promise<void> {
    const local = refList('refs/heads', 'refs/heads/');
    const remote = refList('refs/remotes/origin', 'refs/remotes/origin/');
    sendJson(res, 200, {
      current: currentBranch() ?? null,
      base: await baseBranch(),
      local,
      remoteOnly: remote.filter((name) => !local.includes(name)),
      github: deps.pulls !== undefined,
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

  const mentionIndex = createMentionIndex(deps.contentDir ?? deps.projectDir);
  const mentionReads = createMentionReadStore(
    deps.mentionStateFile ?? mentionStatePath(deps.projectDir),
  );

  const mail = resolveMailConfig(deps.env ?? process.env);
  if (mail.kind === 'invalid') {
    deps.log.warn({ reason: mail.reason }, '[gitquire-mail] email for mentions is off');
  }
  const mailer =
    mail.kind === 'on'
      ? createMentionMailer({
          index: mentionIndex,
          store: mentionReads,
          config: mail.config,
          send: deps.sendMail ?? sendMail,
          log: deps.log,
        })
      : undefined;
  function startMailRounds(): NodeJS.Timeout | undefined {
    if (mailer === undefined) return undefined;
    const timer = setInterval(() => {
      mailer.round().catch(() => undefined);
    }, deps.mailRoundMs ?? DEFAULT_MAIL_ROUND_MS);
    timer.unref();
    return timer;
  }
  const mailTimer = startMailRounds();

  function emailState(userId: number): { available: boolean; address: string | null } {
    return { available: mailer !== undefined, address: mentionReads.emailOf(userId) ?? null };
  }

  function listMentions(req: IncomingMessage, res: ServerResponse): void {
    const user = deps.sessionUser?.(req);
    if (user === undefined) {
      sendJson(res, 200, {
        enabled: false,
        login: null,
        unread: 0,
        mentions: [],
        email: { available: false, address: null },
      });
      return;
    }
    mentionReads.seen(user, new Date());
    const inbox = buildInbox(user, mentionIndex.all(), mentionReads.readIds(user.id));
    sendJson(res, 200, { enabled: true, ...inbox, email: emailState(user.id) });
  }

  async function setMentionEmail(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = deps.sessionUser?.(req);
    if (user === undefined) {
      throw new HttpError(401, 'sign-in-required', 'Sign in to use the mention inbox.');
    }
    const body = await readJson(req);
    if (body.address === null) {
      mentionReads.setEmail(user, undefined, [], new Date());
      deps.log.info({ login: user.login }, '[gitquire-mail] mention email turned off');
      sendJson(res, 200, emailState(user.id));
      return;
    }
    if (mailer === undefined || mail.kind !== 'on') {
      throw new HttpError(409, 'mail-not-configured', 'This server cannot send email.');
    }
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (!isEmailAddress(address)) {
      throw new HttpError(400, 'invalid-address', 'Enter a valid email address.');
    }
    if (!isAllowedRecipient(mail.config, address)) {
      throw new HttpError(400, 'address-not-allowed', 'This server does not mail that domain.');
    }
    const alreadyThere = mentionsFor(user, mentionIndex.all()).map((mention) => mention.id);
    mentionReads.setEmail(user, address, alreadyThere, new Date());
    deps.log.info({ login: user.login, address }, '[gitquire-mail] mention email turned on');
    sendJson(res, 200, emailState(user.id));
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
    if (path === '/api/gitquire/branches' && method === 'GET') return listBranches(res);
    if (path === '/api/gitquire/branches' && method === 'POST') return createBranch(req, res);
    if (path === '/api/gitquire/pulls' && method === 'GET') return listPulls(res);
    if (path === '/api/gitquire/pulls' && method === 'POST') return createPull(req, res);
    if (path === '/api/gitquire/mentions' && method === 'GET') return listMentions(req, res);
    if (path === '/api/gitquire/mentions/read' && method === 'POST') {
      return markMentionsRead(req, res);
    }
    if (path === '/api/gitquire/mentions/email' && method === 'PUT') {
      return setMentionEmail(req, res);
    }
    throw new HttpError(404, 'not-found', 'Unknown GitQuire endpoint.');
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = new URL(req.url ?? '/', 'http://gitquire.invalid').pathname;
    if (!path.startsWith('/api/gitquire/')) return false;
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
    mailRound: () => mailer?.round() ?? Promise.resolve(0),
    stop: () => clearInterval(mailTimer),
  };
}
