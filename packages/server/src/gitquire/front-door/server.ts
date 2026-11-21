import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { type GateLogger, safeNextPath } from '../access-gate.ts';
import { callbackPath, hostNames, signInPath } from '../host/names.ts';
import type { AddableRepo, DoorHost, HostHealth, HostPerson, HostRepo } from '../host/types.ts';
import {
  escapeHtml,
  isSameOriginRequest,
  pathOf,
  redirect,
  sendHtml,
  sendJson,
  wantsHtml,
} from '../http-util.ts';
import { INTERNAL_REQUEST_HEADER } from '../internal-request.ts';
import { principalIdForUser } from '../principal-directory.ts';
import { proxyRequest, proxyUpgrade } from '../process-pool/forward.ts';
import {
  encodeProxiedUser,
  FORWARDED_PREFIX_HEADER,
  FORWARDED_VIEW_HEADER,
  PROXIED_PRINCIPAL_HEADER,
} from '../request-person.ts';
import {
  decodeSigned,
  encodeSigned,
  readCookie,
  safeEqual,
  serializeCookie,
} from '../signed-cookie.ts';
import type { DoorPerson, OpenDecision, WikiAccess } from './access.ts';
import {
  type AllowedOwners,
  allowedOwnersSentence,
  ownerAllowed,
  pinAllowedOwner,
} from './allowed-owners.ts';
import type { MentionCounts } from './mention-counts.ts';
import {
  ADD_WIKI_PAGE,
  ADD_WIKI_TOKEN_FORM,
  type AddWikiHelp,
  addWikiBody,
  homeBody,
  REASON_TEXT,
} from './pages.ts';
import type { FrontDoorSettings } from './settings.ts';
import {
  parseWikiAddress,
  rawPathAndSearch,
  refererAddress,
  stripBrowserHeaders,
  translateResponseHeaders,
  viewCookieName,
} from './translate.ts';
import { WikiClosedError, type WikiProcesses } from './wiki-processes.ts';
import { type WikiRecord, type WikiTable, wikiKey, wikiPrefix } from './wiki-table.ts';

const DOOR_SESSION_COOKIE = 'gq_session';
const DOOR_STATE_COOKIE = 'gq_oauth_state';
const STATE_MAX_AGE_SECONDS = 600;
const ADDABLE_MAX_AGE_MS = 10 * 60 * 1000;
export const RECHECK_MS = 60 * 1000;
const MAX_JSON_BYTES = 16 * 1024;
const FRONT_DOOR_API = '/api/front-door';
const OLD_ADDRESS_SCRIPT = '/_door/old-address.js';

type DoorSessionUser = HostPerson;

interface SessionPayload extends DoorSessionUser {
  v: 1;
  exp: number;
}

type Purpose = 'sign-in' | 'add';

interface StatePayload {
  state: string;
  next: string;
  purpose: Purpose;
  exp: number;
}

interface AddableEntry {
  at: number;
  repos: readonly AddableRepo[] | undefined;
  answer: 'listed' | 'refused' | 'unreachable';
}

export interface ForgejoTokenChecks {
  check: (repo: HostRepo, token: string) => Promise<HostHealth>;
  save: (key: string, token: string) => void;
  isBotToken: (token: string) => boolean;
}

export interface FrontDoorDeps {
  settings: FrontDoorSettings;
  host: DoorHost;
  table: WikiTable;
  owners: AllowedOwners;
  access: WikiAccess;
  processes: WikiProcesses;
  forgejoTokens?: ForgejoTokenChecks;
  addWikiHelp?: () => Promise<AddWikiHelp>;
  mentionCounts?: MentionCounts;
  log: GateLogger;
  now?: () => number;
  randomState?: () => string;
}

export interface FrontDoor {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => void;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  recheckConnections: () => Promise<void>;
  setReady: (ready: boolean) => void;
}

interface OpenConnection {
  person: DoorPerson;
  key: string;
  socket: Duplex;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.id === 'number' &&
    typeof v.login === 'string' &&
    typeof v.name === 'string' &&
    typeof v.avatarUrl === 'string' &&
    typeof v.exp === 'number'
  );
}

function isStatePayload(value: unknown): value is StatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === 'string' &&
    typeof v.next === 'string' &&
    (v.purpose === 'sign-in' || v.purpose === 'add') &&
    typeof v.exp === 'number'
  );
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_JSON_BYTES) throw new Error('body-too-large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(req);
  const parsed: unknown = text === '' ? {} : JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body-not-an-object');
  }
  return parsed as Record<string, unknown>;
}

function refuseUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

interface AddableView {
  id: number;
  owner: string;
  name: string;
  blocked?: 'bot-not-admin';
  wiki?: string;
}

interface ListedWithUnread {
  wiki: WikiRecord;
  admin: boolean;
  unread?: number;
}

interface AddableAnswer {
  state: 'listed' | 'refused' | 'unreachable';
  repos: AddableView[];
  hosts: string;
  needsToken: boolean;
  canAdd: boolean;
}

interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(req));
}

export function createFrontDoor(deps: FrontDoorDeps): FrontDoor {
  const { settings, host, table, access, processes } = deps;
  const now = deps.now ?? Date.now;
  const randomState = deps.randomState ?? (() => randomBytes(24).toString('base64url'));
  const secure = settings.externalUrl.protocol === 'https:';
  const names = hostNames();
  const label = names.label;
  const loginPath = signInPath(names);
  const returnPath = callbackPath(names);
  const addPath = `/auth/${names.kind}/add-wiki`;
  const callbackUrl = new URL(returnPath, settings.externalUrl).toString();
  const addable = new Map<number, AddableEntry>();
  const connections = new Set<OpenConnection>();
  let ready = false;

  const cookie = (name: string, value: string, maxAgeSeconds: number): string =>
    serializeCookie(name, value, { maxAgeSeconds, secure });

  function sessionUser(req: IncomingMessage): DoorSessionUser | undefined {
    const decoded = decodeSigned(settings.sessionSecret, readCookie(req, DOOR_SESSION_COOKIE));
    if (!isSessionPayload(decoded) || decoded.exp * 1000 <= now()) return undefined;
    return {
      id: decoded.id,
      login: decoded.login,
      name: decoded.name,
      avatarUrl: decoded.avatarUrl,
    };
  }

  function isServerAdmin(user: DoorSessionUser): boolean {
    return settings.serverAdmins.has(user.login.toLowerCase());
  }

  function defaultWiki(): WikiRecord | undefined {
    const wanted = settings.defaultWiki;
    if (wanted === undefined) return undefined;
    const match = table.byAddress(wanted.owner, wanted.name);
    return match?.current === true ? match.wiki : undefined;
  }

  function signInAddress(next: string): string {
    return `${loginPath}?next=${encodeURIComponent(next)}`;
  }

  function needSignIn(req: IncomingMessage, res: ServerResponse, next: string): void {
    if (wantsHtml(req)) {
      redirect(res, signInAddress(next));
    } else {
      sendJson(res, 401, { error: 'not-signed-in', signIn: loginPath });
    }
  }

  function startLogin(res: ServerResponse, search: string, purpose: Purpose): void {
    const next = safeNextPath(new URLSearchParams(search).get('next'));
    const state = randomState();
    const payload: StatePayload = {
      state,
      next,
      purpose,
      exp: Math.floor(now() / 1000) + STATE_MAX_AGE_SECONDS,
    };
    redirect(
      res,
      host.authorizeUrl({ clientId: settings.clientId, redirectUri: callbackUrl, state }),
      {
        'Set-Cookie': cookie(
          DOOR_STATE_COOKIE,
          encodeSigned(settings.sessionSecret, payload),
          STATE_MAX_AGE_SECONDS,
        ),
      },
    );
  }

  async function rememberAddable(person: HostPerson, token: string): Promise<void> {
    const answer = await host.addableRepos(token).catch(() => ({ state: 'unreachable' as const }));
    addable.set(person.id, {
      at: now(),
      answer: answer.state,
      repos: answer.state === 'listed' ? answer.repos : undefined,
    });
  }

  async function completeLogin(
    req: IncomingMessage,
    res: ServerResponse,
    search: string,
  ): Promise<void> {
    const params = new URLSearchParams(search);
    const code = params.get('code');
    const state = params.get('state');
    const stored = decodeSigned(settings.sessionSecret, readCookie(req, DOOR_STATE_COOKIE));
    const clearState = cookie(DOOR_STATE_COOKIE, '', 0);
    const tryAgain = `<p><a href="${loginPath}">Sign in with ${label}</a></p>`;
    if (params.get('error') !== null) {
      sendHtml(
        res,
        401,
        'Sign-in cancelled',
        `<p>${label} did not complete the sign-in.</p>${tryAgain}`,
        {
          'Set-Cookie': clearState,
        },
      );
      return;
    }
    if (
      code === null ||
      state === null ||
      !isStatePayload(stored) ||
      stored.exp * 1000 <= now() ||
      !safeEqual(state, stored.state)
    ) {
      sendHtml(
        res,
        400,
        'Sign-in expired',
        `<p>The sign-in link expired or was opened in another browser.</p>${tryAgain}`,
        { 'Set-Cookie': clearState },
      );
      return;
    }
    const token = await host.exchangeCode({
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      code,
      redirectUri: callbackUrl,
    });
    const person = token === undefined ? undefined : await host.person(token);
    if (token === undefined || person === undefined) {
      deps.log.warn({ gotToken: token !== undefined }, `[gitquire-door] ${label} sign-in failed`);
      sendHtml(
        res,
        502,
        'Sign-in failed',
        `<p>${label} did not confirm the sign-in.</p>${tryAgain}`,
        {
          'Set-Cookie': clearState,
        },
      );
      return;
    }
    await Promise.all([
      access.signIn(person, token, table.list()),
      stored.purpose === 'add' ? rememberAddable(person, token) : Promise.resolve(),
    ]);
    const session: SessionPayload = {
      v: 1,
      ...person,
      exp: Math.floor(now() / 1000) + settings.sessionMaxAgeSeconds,
    };
    deps.log.info({ login: person.login, purpose: stored.purpose }, '[gitquire-door] signed in');
    redirect(res, stored.next, {
      'Set-Cookie': [
        clearState,
        cookie(
          DOOR_SESSION_COOKIE,
          encodeSigned(settings.sessionSecret, session),
          settings.sessionMaxAgeSeconds,
        ),
      ],
    });
  }

  function handleAuth(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    search: string,
  ): void {
    if (path === loginPath) {
      startLogin(res, search, 'sign-in');
      return;
    }
    if (path === addPath) {
      if (sessionUser(req) === undefined) {
        needSignIn(req, res, `${path}${search}`);
        return;
      }
      startLogin(res, search, 'add');
      return;
    }
    if (path === returnPath) {
      completeLogin(req, res, search).catch((err: unknown) => {
        deps.log.error({ err }, '[gitquire-door] sign-in callback failed');
        if (!res.headersSent) {
          sendHtml(
            res,
            502,
            'Sign-in failed',
            `<p>Could not reach ${label}. Try again in a moment.</p>`,
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      return;
    }
    if (path === '/auth/logout') {
      if (req.method === 'POST') {
        const user = sessionUser(req);
        if (user !== undefined) {
          access.forget(user);
          addable.delete(user.id);
        }
        sendHtml(
          res,
          200,
          'Signed out',
          `<p>You are signed out of GitQuire.</p><p><a href="${loginPath}">Sign in with ${label}</a></p>`,
          { 'Set-Cookie': cookie(DOOR_SESSION_COOKIE, '', 0) },
        );
        return;
      }
      const user = sessionUser(req);
      const who = user === undefined ? '' : ` as <strong>@${escapeHtml(user.login)}</strong>`;
      sendHtml(
        res,
        200,
        'Sign out',
        `<p>You are signed in${who}.</p><form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>`,
      );
      return;
    }
    if (path === '/auth/me') {
      const user = sessionUser(req);
      if (user === undefined) {
        sendJson(res, 401, { error: 'not-signed-in', signIn: loginPath });
        return;
      }
      sendJson(res, 200, {
        ...user,
        principalId: principalIdForUser(user.id),
        serverAdmin: isServerAdmin(user),
        wikis: true,
      });
      return;
    }
    sendJson(res, 404, { error: 'not-found' });
  }

  function wikiView(wiki: WikiRecord, admin: boolean): Record<string, unknown> {
    return {
      key: wiki.key,
      host: wiki.host,
      owner: wiki.owner,
      name: wiki.name,
      address: `${wikiPrefix(wiki)}/`,
      admin,
      state: wiki.state,
      ...(admin && wiki.state !== 'on'
        ? { reason: wiki.reason ?? null, why: REASON_TEXT[wiki.reason ?? ''] ?? null }
        : {}),
    };
  }

  function unreadIn(user: DoorSessionUser, wiki: WikiRecord): number | undefined {
    if (deps.mentionCounts === undefined || wiki.state !== 'on') return undefined;
    try {
      return deps.mentionCounts.unread(user, wiki);
    } catch (err) {
      deps.log.warn({ err, wiki: wiki.key }, '[gitquire-door] could not count mentions');
      return undefined;
    }
  }

  async function openableWikis(user: DoorSessionUser): Promise<ListedWithUnread[]> {
    const listed = await access.wikisFor(user, table.list());
    return listed.map(({ wiki, admin }) => {
      const unread = unreadIn(user, wiki);
      return unread === undefined ? { wiki, admin } : { wiki, admin, unread };
    });
  }

  async function listWikis(user: DoorSessionUser): Promise<Record<string, unknown>> {
    const listed = await openableWikis(user);
    const fallback = defaultWiki();
    return {
      wikis: listed.map(({ wiki, admin, unread }) => ({
        ...wikiView(wiki, admin),
        ...(unread === undefined ? {} : { unread }),
      })),
      unread: listed.reduce((sum, { unread }) => sum + (unread ?? 0), 0),
      hosts: allowedOwnersSentence(deps.owners),
      defaultWiki: fallback === undefined ? null : `${wikiPrefix(fallback)}/`,
      addWiki: addPath,
      addWikiPage: ADD_WIKI_PAGE,
    };
  }

  function addableAnswer(user: DoorSessionUser): AddableAnswer | undefined {
    const entry = addable.get(user.id);
    if (entry === undefined || now() - entry.at > ADDABLE_MAX_AGE_MS) return undefined;
    const repos = (entry.repos ?? [])
      .filter((repo) => ownerAllowed(deps.owners, repo))
      .map((repo): AddableView => {
        const existing = table.byId(repo.host, repo.id);
        return {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          ...(repo.blocked === undefined ? {} : { blocked: repo.blocked }),
          ...(existing === undefined ? {} : { wiki: `${wikiPrefix(existing)}/` }),
        };
      });
    return {
      state: entry.answer,
      repos,
      hosts: allowedOwnersSentence(deps.owners),
      needsToken: settings.host === 'forgejo',
      canAdd: settings.host !== 'forgejo' || isServerAdmin(user),
    };
  }

  async function addWiki(user: DoorSessionUser, id: unknown, given: unknown): Promise<Outcome> {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      return {
        status: 400,
        body: { error: 'invalid-id', message: 'Send the repository id as a number.' },
      };
    }
    const entry = addable.get(user.id);
    if (entry === undefined || now() - entry.at > ADDABLE_MAX_AGE_MS || entry.repos === undefined) {
      return {
        status: 409,
        body: { error: 'sign-in-again', message: `Confirm with ${label} first.`, signIn: addPath },
      };
    }
    const repo = entry.repos.find((item) => item.id === id);
    if (repo === undefined) {
      return {
        status: 403,
        body: {
          error: 'not-addable',
          message: `Only an administrator of the repository can make it a wiki, and GitQuire must have access to it.`,
        },
      };
    }
    if (repo.blocked === 'bot-not-admin') {
      return {
        status: 409,
        body: {
          error: 'bot-not-admin',
          message: "Make GitQuire's account an administrator of the repository first.",
        },
      };
    }
    if (!ownerAllowed(deps.owners, repo)) {
      return {
        status: 403,
        body: { error: 'owner-not-allowed', message: allowedOwnersSentence(deps.owners) },
      };
    }
    const existing = table.byId(repo.host, repo.id);
    if (existing !== undefined) {
      return {
        status: 409,
        body: {
          error: 'already-a-wiki',
          message: 'This repository is already a wiki.',
          wiki: wikiView(existing, true),
        },
      };
    }
    const key = wikiKey(repo);
    if (deps.forgejoTokens !== undefined) {
      if (!isServerAdmin(user)) {
        return {
          status: 403,
          body: {
            error: 'server-admin-only',
            message: 'On Forgejo, a server administrator adds a wiki and enters its token.',
          },
        };
      }
      const token = typeof given === 'string' ? given.trim() : '';
      if (token === '' || deps.forgejoTokens.isBotToken(token)) {
        return {
          status: 400,
          body: {
            error: 'token-required',
            message:
              "Enter a token of GitQuire's account limited to this repository, with write:repository.",
          },
        };
      }
      const health = await deps.forgejoTokens.check(repo, token);
      if (health !== 'ok') {
        return {
          status: health === 'unreachable' ? 503 : 400,
          body: {
            error: health === 'unreachable' ? 'host-unreachable' : 'token-refused',
            refusal: health,
            message:
              health === 'unreachable'
                ? `${label} cannot be reached right now.`
                : "The token cannot write to this repository, or GitQuire's account is not its administrator.",
          },
        };
      }
      deps.forgejoTokens.save(key, token);
    }
    pinAllowedOwner(deps.owners, repo);
    const wiki = table.add(repo, user.login, now());
    access.learn(user, wiki, 'admin');
    deps.log.info(
      { wiki: wiki.key, repo: `${wiki.owner}/${wiki.name}`, by: user.login },
      '[gitquire-door] a repository became a wiki',
    );
    return { status: 201, body: { wiki: wikiView(wiki, true) } };
  }

  async function makeWiki(
    req: IncomingMessage,
    res: ServerResponse,
    user: DoorSessionUser,
  ): Promise<void> {
    const body = await readJson(req);
    const outcome = await addWiki(user, body.id, body.token);
    sendJson(res, outcome.status, outcome.body);
  }

  async function newToken(user: DoorSessionUser, key: string, given: unknown): Promise<Outcome> {
    const wiki = table.byKey(key);
    if (deps.forgejoTokens === undefined || wiki === undefined) {
      return { status: 404, body: { error: 'not-found' } };
    }
    if (!isServerAdmin(user)) return { status: 403, body: { error: 'server-admin-only' } };
    const token = typeof given === 'string' ? given.trim() : '';
    if (token === '' || deps.forgejoTokens.isBotToken(token)) {
      return { status: 400, body: { error: 'token-required' } };
    }
    const health = await deps.forgejoTokens.check(wiki, token);
    if (health !== 'ok') {
      return {
        status: health === 'unreachable' ? 503 : 400,
        body: { error: 'token-refused', refusal: health },
      };
    }
    deps.forgejoTokens.save(key, token);
    await processes.check(wiki);
    return { status: 200, body: { wiki: wikiView(wiki, true) } };
  }

  async function replaceToken(
    req: IncomingMessage,
    res: ServerResponse,
    user: DoorSessionUser,
    key: string,
  ): Promise<void> {
    if (deps.forgejoTokens === undefined || table.byKey(key) === undefined) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const body = await readJson(req);
    const outcome = await newToken(user, key, body.token);
    sendJson(res, outcome.status, outcome.body);
  }

  function handleApi(req: IncomingMessage, res: ServerResponse, path: string): void {
    const user = sessionUser(req);
    if (user === undefined) {
      sendJson(res, 401, { error: 'not-signed-in', signIn: loginPath });
      return;
    }
    const method = req.method ?? 'GET';
    if (method !== 'GET' && !isSameOriginRequest(req, settings.externalUrl)) {
      sendJson(res, 403, { error: 'cross-origin' });
      return;
    }
    const fail = (err: unknown): void => {
      deps.log.warn({ err, path }, '[gitquire-door] request failed');
      if (!res.headersSent) sendJson(res, 400, { error: 'bad-request' });
    };
    if (path === `${FRONT_DOOR_API}/wikis` && method === 'GET') {
      listWikis(user).then((body) => sendJson(res, 200, body), fail);
      return;
    }
    if (path === `${FRONT_DOOR_API}/wikis` && method === 'POST') {
      makeWiki(req, res, user).catch(fail);
      return;
    }
    if (path === `${FRONT_DOOR_API}/addable` && method === 'GET') {
      const answer = addableAnswer(user);
      if (answer === undefined) {
        sendJson(res, 409, { error: 'sign-in-again', signIn: addPath });
      } else {
        sendJson(res, 200, answer);
      }
      return;
    }
    const tokenRoute = new RegExp(`^${FRONT_DOOR_API}/wikis/([a-z0-9-]+)/token$`).exec(path);
    if (tokenRoute !== null && method === 'PUT') {
      replaceToken(req, res, user, tokenRoute[1]).catch(fail);
      return;
    }
    sendJson(res, 404, { error: 'not-found' });
  }

  function closedAnswer(
    req: IncomingMessage,
    res: ServerResponse,
    wiki: WikiRecord,
    user: DoorSessionUser,
    decision: Exclude<OpenDecision, { open: true }>,
  ): void {
    const repo = `${wiki.owner}/${wiki.name}`;
    const status = decision.why === 'unreachable' ? 503 : 403;
    if (!wantsHtml(req)) {
      sendJson(res, status, {
        error: decision.why === 'no-access' ? 'no-access' : decision.why,
        ...(decision.why === 'disconnected' && access.wasAdmin(user, wiki)
          ? { reason: wiki.reason ?? null }
          : {}),
      });
      return;
    }
    const body =
      decision.why === 'no-access'
        ? `<p>The ${label} account <strong>@${escapeHtml(user.login)}</strong> does not have write access to <code>${escapeHtml(repo)}</code>. Ask its owner for access, then <a href="${signInAddress(`${wikiPrefix(wiki)}/`)}">sign in again</a>.</p>`
        : decision.why === 'unreachable'
          ? `<p>${label} cannot be reached right now, so GitQuire cannot check your access to <code>${escapeHtml(repo)}</code>. Try again in a moment.</p>`
          : `<p>The wiki <code>${escapeHtml(repo)}</code> is disconnected.</p>${access.wasAdmin(user, wiki) ? `<p>${escapeHtml(REASON_TEXT[wiki.reason ?? ''] ?? '')}</p>` : ''}`;
    sendHtml(
      res,
      status,
      decision.why === 'no-access' ? 'No access' : 'Wiki unavailable',
      `${body}<p><a href="/">Your wikis</a></p>`,
    );
  }

  function notAWiki(req: IncomingMessage, res: ServerResponse, owner: string): void {
    const sentence = allowedOwnersSentence(deps.owners);
    if (wantsHtml(req)) {
      const listedOwner = deps.owners.names.has(owner.toLowerCase());
      sendHtml(
        res,
        404,
        listedOwner ? 'No wiki yet' : 'No wiki here',
        `${listedOwner ? `<p>This repository is not a wiki yet. An administrator of it can make it one at <a href="${ADD_WIKI_PAGE}">Add a wiki</a>.</p>` : '<p>There is no wiki at this address.</p>'}<p>${escapeHtml(sentence)}</p><p><a href="/">Your wikis</a></p>`,
      );
    } else {
      sendJson(res, 404, { error: 'not-a-wiki', hosts: sentence });
    }
  }

  function forwardHeaders(
    user: DoorSessionUser,
    wiki: WikiRecord,
    admin: boolean,
    view: string | undefined,
  ): Record<string, string> {
    const secret = processes.secretOf(wiki.key) ?? '';
    return {
      [INTERNAL_REQUEST_HEADER]: secret,
      [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser({
        ...user,
        ...(admin ? { repoAdmin: true } : {}),
      }),
      [FORWARDED_PREFIX_HEADER]: wikiPrefix(wiki),
      ...(view === undefined || view === '' ? {} : { [FORWARDED_VIEW_HEADER]: view }),
    };
  }

  function unavailable(
    res: ServerResponse,
    req: IncomingMessage,
    wiki: WikiRecord,
    err: unknown,
  ): void {
    const closed = err instanceof WikiClosedError;
    deps.log.warn({ err, wiki: wiki.key }, '[gitquire-door] could not start a wiki');
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (wantsHtml(req)) {
      sendHtml(
        res,
        closed ? 403 : 502,
        'Wiki unavailable',
        `<p>${closed ? 'This wiki is disconnected.' : 'The wiki could not be started. Try again in a moment.'}</p><p><a href="/">Your wikis</a></p>`,
      );
    } else {
      sendJson(res, closed ? 403 : 502, { error: closed ? 'disconnected' : 'wiki-unavailable' });
    }
  }

  async function toWiki(
    req: IncomingMessage,
    res: ServerResponse,
    user: DoorSessionUser,
    wiki: WikiRecord,
    path: string,
    view: string | undefined,
  ): Promise<void> {
    const decision = await access.decide(user, wiki);
    if (!decision.open) {
      closedAnswer(req, res, wiki, user, decision);
      return;
    }
    let socket: string;
    try {
      socket = await processes.ensure(wiki);
    } catch (err) {
      unavailable(res, req, wiki, err);
      return;
    }
    processes.touch(wiki.key);
    stripBrowserHeaders(req);
    req.url = path;
    proxyRequest(req, res, socket, {
      extraHeaders: forwardHeaders(user, wiki, decision.admin, view),
      unavailable: { error: 'wiki-unavailable', message: 'The wiki is not reachable.' },
      rewriteHeaders: (headers) =>
        translateResponseHeaders(headers, { prefix: wikiPrefix(wiki), key: wiki.key, secure }),
    });
  }

  function lookup(owner: string, name: string): { wiki: WikiRecord; current: boolean } | undefined {
    return table.byAddress(owner, name);
  }

  function oldAddressScript(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      "(()=>{const d=document.getElementById('gq-default-wiki');const a=d&&d.dataset.address;if(a&&location.hash.length>1)location.replace(a+location.hash);})();\n",
    );
  }

  async function homePage(res: ServerResponse, user: DoorSessionUser): Promise<void> {
    const listed = await openableWikis(user);
    const fallback = defaultWiki();
    sendHtml(
      res,
      200,
      'Your wikis',
      homeBody({
        rows: listed,
        defaultAddress:
          fallback === undefined || !listed.some(({ wiki }) => wiki.key === fallback.key)
            ? undefined
            : `${wikiPrefix(fallback)}/`,
        hosts: allowedOwnersSentence(deps.owners),
        canReplaceToken: deps.forgejoTokens !== undefined && isServerAdmin(user),
        scriptPath: OLD_ADDRESS_SCRIPT,
      }),
    );
  }

  async function addWikiHelp(): Promise<AddWikiHelp> {
    if (deps.addWikiHelp === undefined) return {};
    return deps.addWikiHelp().catch((): AddWikiHelp => ({}));
  }

  async function addWikiPage(
    res: ServerResponse,
    user: DoorSessionUser,
    failed?: Outcome,
  ): Promise<void> {
    const answer = addableAnswer(user);
    const reload = `${addPath}?next=${encodeURIComponent(ADD_WIKI_PAGE)}`;
    if (answer === undefined) {
      redirect(res, reload);
      return;
    }
    const message = failed?.body.message;
    sendHtml(
      res,
      failed?.status ?? 200,
      'Add a wiki',
      addWikiBody({
        host: settings.host,
        label,
        state: answer.state,
        repos: answer.repos,
        hosts: answer.hosts,
        canAdd: answer.canAdd,
        needsToken: answer.needsToken,
        help: await addWikiHelp(),
        reload,
        ...(typeof message === 'string' ? { message } : {}),
      }),
    );
  }

  async function addWikiForm(
    req: IncomingMessage,
    res: ServerResponse,
    user: DoorSessionUser,
  ): Promise<void> {
    const form = await readForm(req);
    const raw = form.get('id') ?? '';
    const id = /^[0-9]{1,15}$/.test(raw) ? Number(raw) : undefined;
    const outcome = await addWiki(user, id, form.get('token') ?? undefined);
    if (outcome.status === 201) {
      const wiki = outcome.body.wiki as { address: string };
      res.writeHead(303, { Location: wiki.address, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (outcome.body.error === 'sign-in-again') {
      redirect(res, `${addPath}?next=${encodeURIComponent(ADD_WIKI_PAGE)}`);
      return;
    }
    await addWikiPage(res, user, outcome);
  }

  async function tokenForm(
    req: IncomingMessage,
    res: ServerResponse,
    user: DoorSessionUser,
  ): Promise<void> {
    const form = await readForm(req);
    const outcome = await newToken(user, form.get('key') ?? '', form.get('token') ?? undefined);
    if (outcome.status === 200) {
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendHtml(
      res,
      outcome.status,
      'Token not saved',
      `<p>${outcome.body.error === 'token-refused' ? 'The token cannot write to this repository.' : 'The token was not saved.'}</p><p><a href="/">Your wikis</a></p>`,
    );
  }

  function handlePages(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    user: DoorSessionUser | undefined,
    fail: (err: unknown) => void,
  ): boolean {
    if (path !== ADD_WIKI_PAGE && path !== ADD_WIKI_TOKEN_FORM) return false;
    const method = req.method ?? 'GET';
    if (user === undefined) {
      needSignIn(req, res, ADD_WIKI_PAGE);
      return true;
    }
    if (path === ADD_WIKI_PAGE && (method === 'GET' || method === 'HEAD')) {
      addWikiPage(res, user).catch(fail);
      return true;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return true;
    }
    if (!isSameOriginRequest(req, settings.externalUrl)) {
      sendJson(res, 403, { error: 'cross-origin' });
      return true;
    }
    (path === ADD_WIKI_PAGE ? addWikiForm(req, res, user) : tokenForm(req, res, user)).catch(fail);
    return true;
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const { path: rawPath, search } = rawPathAndSearch(req.url);
    if (rawPath === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (rawPath === '/readyz') {
      sendJson(res, ready ? 200 : 503, { ready });
      return;
    }
    const user = sessionUser(req);
    const address = parseWikiAddress(req.url);
    const viewFor = (key: string): string | undefined => readCookie(req, viewCookieName(key));
    const fail = (err: unknown): void => {
      deps.log.error({ err, path: rawPath }, '[gitquire-door] request failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'front-door-error' });
      else if (!res.writableEnded) res.destroy();
    };

    if (address !== undefined) {
      const match = lookup(address.owner, address.name);
      if (user === undefined) {
        needSignIn(req, res, `${rawPath}${search}`);
        return;
      }
      if (match === undefined) {
        notAWiki(req, res, address.owner);
        return;
      }
      if (!match.current || address.rest === '') {
        res.writeHead(match.current ? 302 : 301, {
          Location: `${wikiPrefix(match.wiki)}${address.rest === '' ? '/' : address.rest}${address.search}`,
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      toWiki(
        req,
        res,
        user,
        match.wiki,
        `${address.rest}${address.search}`,
        viewFor(match.wiki.key),
      ).catch(fail);
      return;
    }

    const { path } = pathOf(req);
    if (path.startsWith('/auth/')) {
      handleAuth(req, res, path, search);
      return;
    }
    if (path === FRONT_DOOR_API || path.startsWith(`${FRONT_DOOR_API}/`)) {
      handleApi(req, res, path);
      return;
    }
    if (handlePages(req, res, path, user, fail)) return;
    if (path === OLD_ADDRESS_SCRIPT) {
      oldAddressScript(res);
      return;
    }
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (user === undefined) {
        needSignIn(req, res, '/');
        return;
      }
      homePage(res, user).catch(fail);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const from = refererAddress(req, settings.externalUrl.origin);
      const match = from === undefined ? undefined : lookup(from.owner, from.name);
      if (user !== undefined && match?.current === true) {
        toWiki(req, res, user, match.wiki, `${rawPath}${search}`, viewFor(match.wiki.key)).catch(
          fail,
        );
        return;
      }
      const fallback = defaultWiki();
      if (fallback !== undefined && wantsHtml(req) && !path.startsWith('/api/')) {
        redirect(res, `${wikiPrefix(fallback)}${rawPath}${search}`);
        return;
      }
    }
    sendJson(res, 404, { error: 'wiki-address-required' });
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const user = sessionUser(req);
    const address = parseWikiAddress(req.url);
    const cookies = { headers: { cookie: req.headers.cookie } } as IncomingMessage;
    stripBrowserHeaders(req);
    if (address === undefined || address.rest === '') {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    if (user === undefined) {
      refuseUpgrade(socket, '401 Unauthorized');
      return;
    }
    const match = lookup(address.owner, address.name);
    if (match === undefined || !match.current) {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    const wiki = match.wiki;
    const viewSlug = readCookie(cookies, viewCookieName(wiki.key));
    void (async () => {
      const decision = await access.decide(user, wiki);
      if (!decision.open) {
        refuseUpgrade(
          socket,
          decision.why === 'unreachable' ? '503 Service Unavailable' : '403 Forbidden',
        );
        return;
      }
      const target = await processes.ensure(wiki);
      const release = processes.hold(wiki.key);
      const connection: OpenConnection = { person: user, key: wiki.key, socket };
      connections.add(connection);
      req.url = `${address.rest}${address.search}`;
      proxyUpgrade(
        req,
        socket,
        head,
        target,
        () => {
          connections.delete(connection);
          release();
        },
        forwardHeaders(user, wiki, decision.admin, viewSlug),
      );
    })().catch((err: unknown) => {
      deps.log.warn({ err, wiki: wiki.key }, '[gitquire-door] websocket to a wiki failed');
      refuseUpgrade(socket, '502 Bad Gateway');
    });
  }

  async function recheckConnections(): Promise<void> {
    await Promise.all(
      [...connections].map(async (connection) => {
        const wiki = table.byKey(connection.key);
        const decision =
          wiki === undefined
            ? ({ open: false, why: 'disconnected' } as const)
            : await access.decide(connection.person, wiki);
        if (decision.open || decision.why === 'unreachable') return;
        deps.log.info(
          { wiki: connection.key, login: connection.person.login, why: decision.why },
          '[gitquire-door] closing a live-editing connection: access ended',
        );
        connections.delete(connection);
        connection.socket.destroy();
      }),
    );
  }

  return {
    handleRequest,
    handleUpgrade,
    recheckConnections,
    setReady: (value) => {
      ready = value;
    },
  };
}
