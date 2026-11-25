import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { type GateLogger, safeNextPath } from '../access-gate.ts';
import { isSlug } from '../drafts/model.ts';
import type { AddableRepo, HostHealth, HostPerson, HostRepoRecord } from '../host/types.ts';
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
import type { PersonRoutes } from '../people/person-routes.ts';
import { PERSON_TICKET_HEADER, type PersonTickets } from '../people/ticket.ts';
import { proxyRequest, proxyUpgrade } from '../process-pool/forward.ts';
import {
  encodeProxiedUser,
  FORWARDED_AGENTS_HEADER,
  FORWARDED_AGENTS_HOST_HEADER,
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
import type { DoorPerson, OpenDecision } from './access.ts';
import type { DoorAgents } from './agents.ts';
import { allowedOwnersSentence, ownerAllowed, pinAllowedOwner } from './allowed-owners.ts';
import { type DoorHostEntry, type DoorHosts, personIdOn } from './door-hosts.ts';
import {
  type DoorAccount,
  hostFingerprint,
  readDoorSession,
  writeDoorSession,
} from './door-session.ts';
import { hostKeyOf } from './hosts.ts';
import type { MentionCounts } from './mention-counts.ts';
import {
  ADD_WIKI_PAGE,
  ADD_WIKI_TOKEN_FORM,
  type AddWikiHelp,
  addWikiBody,
  homeBody,
  REASON_TEXT,
  REMOVE_WIKI_FORM,
} from './pages.ts';
import type { FrontDoorSettings } from './settings.ts';
import {
  parseWikiAddress,
  rawPathAndSearch,
  refererAddress,
  stripBrowserHeaders,
  translateResponseHeaders,
  viewCookieName,
  type WikiAddress,
} from './translate.ts';
import { WikiClosedError, type WikiProcesses } from './wiki-processes.ts';
import {
  type WikiRecord,
  type WikiTable,
  wikiDir,
  wikiKey,
  wikiName,
  wikiPrefix,
} from './wiki-table.ts';

const DOOR_SESSION_COOKIE = 'gq_session';
const DOOR_STATE_COOKIE = 'gq_oauth_state';
const STATE_MAX_AGE_SECONDS = 600;
export const ADDABLE_MAX_AGE_MS = 30 * 60 * 1000;
export const PENDING_ADD_MAX_AGE_MS = 10 * 60 * 1000;
export const RECHECK_MS = 60 * 1000;
const MAX_JSON_BYTES = 16 * 1024;
export const HOST_LIST_DEADLINE_MS = 8000;

function withinDeadline<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
  if (!Number.isFinite(ms)) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(late()), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
const FRONT_DOOR_API = '/api/front-door';

type DoorSessionUser = HostPerson;

type Purpose = 'sign-in' | 'add';

interface StatePayload {
  state: string;
  next: string;
  purpose: Purpose;
  host?: string;
  exp: number;
}

interface PendingAdd {
  id: number;
  token: string | undefined;
  at: number;
}

interface AddableEntry {
  at: number;
  repos: readonly AddableRepo[] | undefined;
  answer: 'listed' | 'refused' | 'unreachable';
}

export type TokenCheck = HostHealth | 'not-limited' | 'cannot-confirm';

const TOKEN_REFUSED_TEXT: Record<string, string> = {
  'not-limited':
    'The token reaches other repositories too. Create one limited to this repository only.',
  'cannot-confirm':
    "GitQuire cannot check that the token is limited to this repository: give GitQuire's bot account access to one more repository (any, even an empty one) and try again.",
};

function refusalOutcome(label: string, health: TokenCheck): Outcome {
  return {
    status: health === 'unreachable' ? 503 : 400,
    body: {
      error: health === 'unreachable' ? 'host-unreachable' : 'token-refused',
      refusal: health,
      message:
        health === 'unreachable'
          ? `${label} cannot be reached right now.`
          : (TOKEN_REFUSED_TEXT[health] ??
            "The token cannot write to this repository, or GitQuire's account is not its administrator."),
    },
  };
}

export interface ForgejoTokenChecks {
  check: (repo: HostRepoRecord, token: string) => Promise<TokenCheck>;
  save: (key: string, token: string) => void;
  forget: (key: string) => void;
  isBotToken: (token: string) => boolean;
}

export interface FrontDoorDeps {
  settings: FrontDoorSettings;
  hosts: DoorHosts;
  table: WikiTable;
  processes: WikiProcesses;
  agents?: Pick<DoorAgents, 'handle' | 'features' | 'pathsFor'>;
  mentionCounts?: MentionCounts;
  tickets?: PersonTickets;
  seen?: (person: string, login: string) => void;
  personRoutes?: PersonRoutes;
  readAccountAddress?: (entry: DoorHostEntry, person: HostPerson, token: string) => Promise<void>;
  log: GateLogger;
  now?: () => number;
  randomState?: () => string;
  listDeadlineMs?: number;
}

export interface FrontDoor {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => void;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  recheckConnections: () => Promise<void>;
  setReady: (ready: boolean) => void;
  sessionUser: (req: IncomingMessage, hostKey?: string) => HostPerson | undefined;
}

interface Seat {
  entry: DoorHostEntry;
  person: HostPerson;
}

interface ResolvedAddress {
  wiki: WikiRecord;
  current: boolean;
  rest: string;
  search: string;
}

type Accounts = ReadonlyMap<string, DoorAccount>;

interface OpenConnection {
  seat: Seat;
  key: string;
  socket: Duplex;
}

function isStatePayload(value: unknown): value is StatePayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === 'string' &&
    typeof v.next === 'string' &&
    (v.purpose === 'sign-in' || v.purpose === 'add') &&
    (v.host === undefined || typeof v.host === 'string') &&
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
  seat: Seat;
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
  const { settings, hosts, table, processes } = deps;
  const primary = hosts.primary;
  const { owners } = primary;
  const now = deps.now ?? Date.now;
  const randomState = deps.randomState ?? (() => randomBytes(24).toString('base64url'));
  const secure = settings.externalUrl.protocol === 'https:';
  const label = primary.names.label;
  const loginPath = primary.paths.login;
  const addPath = primary.paths.addWiki;
  const addable = new Map<string, AddableEntry>();
  const pendingAdds = new Map<string, PendingAdd>();
  const renewed = new Set<string>();
  const slot = (seat: Seat): string => `${seat.entry.key}:${seat.person.id}`;
  const keptMinutes = Math.round(ADDABLE_MAX_AGE_MS / 60_000);
  const connections = new Set<OpenConnection>();
  let ready = false;

  const cookie = (name: string, value: string, maxAgeSeconds: number): string =>
    serializeCookie(name, value, { maxAgeSeconds, secure });

  const sessionHosts = {
    primaryKey: primary.key,
    fingerprints: new Map(
      hosts.list().map((entry) => [entry.key, hostFingerprint(entry.settings)]),
    ),
  };
  const severalHosts = hosts.list().length > 1;
  const chooserPath = '/auth/sign-in';

  function stateCookieName(entry: DoorHostEntry): string {
    return entry === primary
      ? DOOR_STATE_COOKIE
      : `${DOOR_STATE_COOKIE}_${entry.key.replaceAll('-', '_')}`;
  }

  function sessionAccounts(req: IncomingMessage): Map<string, DoorAccount> {
    return readDoorSession(settings.sessionSecret, readCookie(req, DOOR_SESSION_COOKIE), {
      ...sessionHosts,
      nowSeconds: now() / 1000,
    });
  }

  function sessionUser(req: IncomingMessage, hostKey?: string): DoorSessionUser | undefined {
    return sessionAccounts(req).get(hostKey ?? primary.key)?.person;
  }

  function sessionCookie(accounts: ReadonlyMap<string, DoorAccount>): string {
    if (accounts.size === 0) return cookie(DOOR_SESSION_COOKIE, '', 0);
    const lastExp = Math.max(...[...accounts.values()].map((account) => account.exp));
    const maxAge = Math.max(1, Math.ceil(lastExp - now() / 1000));
    return cookie(
      DOOR_SESSION_COOKIE,
      writeDoorSession(settings.sessionSecret, accounts, sessionHosts),
      maxAge,
    );
  }

  function wikisOf(entry: DoorHostEntry): WikiRecord[] {
    return table.list().filter((wiki) => hosts.of(wiki) === entry);
  }

  function seatFor(accounts: Accounts, wiki: WikiRecord): Seat | undefined {
    const entry = hosts.of(wiki);
    if (entry === undefined) return undefined;
    const person = accounts.get(entry.key)?.person;
    return person === undefined ? undefined : { entry, person };
  }

  function decide(seat: Seat, wiki: WikiRecord): Promise<OpenDecision> {
    if (hosts.of(wiki) !== seat.entry) return Promise.resolve({ open: false, why: 'no-access' });
    return seat.entry.access.decide(seat.person, wiki);
  }

  function isAdminOn(entry: DoorHostEntry, person: DoorPerson): boolean {
    return entry.settings.serverAdmins.has(person.login.toLowerCase());
  }

  function isServerAdmin(user: DoorSessionUser): boolean {
    return isAdminOn(primary, user);
  }

  function ownersSentence(): string {
    if (!severalHosts) return allowedOwnersSentence(owners);
    const parts = hosts
      .list()
      .map((entry) => `${[...entry.owners.names].sort().join(', ')} (${entry.names.label})`);
    return `This server hosts wikis from ${parts.join('; ')}.`;
  }

  function accountsView(accounts: Accounts): Record<string, unknown>[] {
    return hosts.list().flatMap((entry) => {
      const mine = accounts.get(entry.key);
      return mine === undefined
        ? []
        : [{ host: entry.key, label: entry.names.label, login: mine.person.login }];
    });
  }

  function signInWith(accounts: Accounts): Record<string, unknown>[] {
    return hosts
      .list()
      .filter((entry) => !accounts.has(entry.key))
      .map((entry) => ({ host: entry.key, label: entry.names.label, address: entry.paths.login }));
  }

  function defaultWiki(): WikiRecord | undefined {
    const wanted = settings.defaultWiki;
    if (wanted === undefined) return undefined;
    const match = table.byAddress(primary.key, wanted.owner, wanted.name);
    return match?.current === true && hosts.of(match.wiki) === primary ? match.wiki : undefined;
  }

  function signInAddress(next: string): string {
    return `${severalHosts ? chooserPath : loginPath}?next=${encodeURIComponent(next)}`;
  }

  function needSignIn(req: IncomingMessage, res: ServerResponse, next: string): void {
    if (wantsHtml(req)) {
      redirect(res, signInAddress(next));
    } else {
      sendJson(res, 401, {
        error: 'not-signed-in',
        signIn: severalHosts ? chooserPath : loginPath,
      });
    }
  }

  function startLogin(
    res: ServerResponse,
    search: string,
    purpose: Purpose,
    entry: DoorHostEntry,
  ): void {
    const next = safeNextPath(new URLSearchParams(search).get('next'));
    const state = randomState();
    const payload: StatePayload = {
      state,
      next,
      purpose,
      host: entry.key,
      exp: Math.floor(now() / 1000) + STATE_MAX_AGE_SECONDS,
    };
    redirect(
      res,
      entry.host.authorizeUrl({
        clientId: entry.settings.clientId,
        redirectUri: new URL(entry.paths.callback, settings.externalUrl).toString(),
        state,
      }),
      {
        'Set-Cookie': cookie(
          stateCookieName(entry),
          encodeSigned(settings.sessionSecret, payload),
          STATE_MAX_AGE_SECONDS,
        ),
      },
    );
  }

  async function rememberAddable(seat: Seat, token: string): Promise<void> {
    const answer = await seat.entry.host
      .addableRepos(token)
      .catch(() => ({ state: 'unreachable' as const }));
    addable.set(slot(seat), {
      at: now(),
      answer: answer.state,
      repos: answer.state === 'listed' ? answer.repos : undefined,
    });
  }

  async function completeLogin(
    req: IncomingMessage,
    res: ServerResponse,
    search: string,
    entry: DoorHostEntry,
  ): Promise<void> {
    const params = new URLSearchParams(search);
    const code = params.get('code');
    const state = params.get('state');
    const stored = decodeSigned(settings.sessionSecret, readCookie(req, stateCookieName(entry)));
    const clearState = cookie(stateCookieName(entry), '', 0);
    const hostLabel = entry.names.label;
    const tryAgain = `<p><a href="${entry.paths.login}">Sign in with ${escapeHtml(hostLabel)}</a></p>`;
    if (params.get('error') !== null) {
      sendHtml(
        res,
        401,
        'Sign-in cancelled',
        `<p>${escapeHtml(hostLabel)} did not complete the sign-in.</p>${tryAgain}`,
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
      !safeEqual(state, stored.state) ||
      (stored.host ?? primary.key) !== entry.key
    ) {
      if (isStatePayload(stored) && (stored.host ?? primary.key) !== entry.key) {
        deps.log.warn(
          { started: stored.host ?? primary.key, callback: entry.key },
          '[gitquire-door] a sign-in came back to another host than it started at; refused',
        );
      }
      sendHtml(
        res,
        400,
        'Sign-in expired',
        `<p>The sign-in link expired or was opened in another browser.</p>${tryAgain}`,
        { 'Set-Cookie': clearState },
      );
      return;
    }
    const token = await entry.host.exchangeCode({
      clientId: entry.settings.clientId,
      clientSecret: entry.settings.clientSecret,
      code,
      redirectUri: new URL(entry.paths.callback, settings.externalUrl).toString(),
    });
    const person = token === undefined ? undefined : await entry.host.person(token);
    if (token === undefined || person === undefined) {
      deps.log.warn(
        { gotToken: token !== undefined, ...(severalHosts ? { host: entry.key } : {}) },
        `[gitquire-door] ${hostLabel} sign-in failed`,
      );
      sendHtml(
        res,
        502,
        'Sign-in failed',
        `<p>${escapeHtml(hostLabel)} did not confirm the sign-in.</p>${tryAgain}`,
        {
          'Set-Cookie': clearState,
        },
      );
      return;
    }
    deps.readAccountAddress?.(entry, person, token).catch((err: unknown) => {
      deps.log.warn(
        { err, login: person.login, ...(severalHosts ? { host: entry.key } : {}) },
        '[gitquire-mail] could not read the account address at sign-in',
      );
    });
    await Promise.all([
      entry.access.signIn(person, token, wikisOf(entry)),
      stored.purpose === 'add' ? rememberAddable({ entry, person }, token) : Promise.resolve(),
    ]);
    const accounts = sessionAccounts(req);
    accounts.set(entry.key, {
      person,
      exp: Math.floor(now() / 1000) + settings.sessionMaxAgeSeconds,
    });
    deps.log.info(
      {
        login: person.login,
        purpose: stored.purpose,
        ...(severalHosts ? { host: entry.key } : {}),
      },
      '[gitquire-door] signed in',
    );
    redirect(res, safeNextPath(stored.next), {
      'Set-Cookie': [clearState, sessionCookie(accounts)],
    });
  }

  function forgetAccount(entry: DoorHostEntry, person: HostPerson): void {
    entry.access.forget(person);
    const key = slot({ entry, person });
    addable.delete(key);
    pendingAdds.delete(key);
    renewed.delete(key);
  }

  function signInChooser(req: IncomingMessage, res: ServerResponse, search: string): void {
    const next = safeNextPath(new URLSearchParams(search).get('next'));
    const accounts = sessionAccounts(req);
    const rows = hosts
      .list()
      .map((entry) => {
        const mine = accounts.get(entry.key);
        const start = `${entry.paths.login}?next=${encodeURIComponent(next)}`;
        return mine === undefined
          ? `<li><a href="${escapeHtml(start)}">Sign in with ${escapeHtml(entry.names.label)}</a></li>`
          : `<li>${escapeHtml(entry.names.label)}: signed in as <strong>@${escapeHtml(mine.person.login)}</strong> (<a href="${escapeHtml(start)}">sign in again</a>)</li>`;
      })
      .join('');
    sendHtml(
      res,
      200,
      'Sign in',
      `<p>Sign in with the Git host of the wiki you want to open. You can be signed in with several hosts at once; each account sees the wikis of its own host.</p><ul>${rows}</ul>`,
    );
  }

  function mcpPathFor(hostKey: string): string {
    const entry = hosts.byKey(hostKey) ?? primary;
    return deps.agents?.pathsFor(entry.key)?.mcp ?? `/mcp/${entry.key}`;
  }

  function agentsOn(entry: DoorHostEntry): string {
    const paths = deps.agents?.pathsFor(entry.key);
    return paths === undefined
      ? ''
      : ` · <a href="${escapeHtml(paths.agents)}">AI agent access</a>`;
  }

  function signOutPage(req: IncomingMessage, res: ServerResponse): void {
    const accounts = sessionAccounts(req);
    const agentsLink =
      deps.agents === undefined ? '' : '<p><a href="/auth/agents">AI agent access</a></p>';
    if (!severalHosts) {
      const user = accounts.get(primary.key)?.person;
      const who = user === undefined ? '' : ` as <strong>@${escapeHtml(user.login)}</strong>`;
      sendHtml(
        res,
        200,
        'Sign out',
        `<p>You are signed in${who}.</p>${agentsLink}<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>`,
      );
      return;
    }
    const rows = hosts
      .list()
      .flatMap((entry) => {
        const mine = accounts.get(entry.key);
        if (mine === undefined) return [];
        return [
          `<li>${escapeHtml(entry.names.label)}: <strong>@${escapeHtml(mine.person.login)}</strong>${agentsOn(entry)} <form method="post" action="/auth/logout" style="display:inline"><input type="hidden" name="host" value="${escapeHtml(entry.key)}"><button type="submit">Sign out of ${escapeHtml(entry.names.label)}</button></form></li>`,
        ];
      })
      .join('');
    sendHtml(
      res,
      200,
      'Sign out',
      `${rows === '' ? '<p>You are not signed in.</p>' : `<ul>${rows}</ul><form method="post" action="/auth/logout"><button type="submit">Sign out of all</button></form>`}<p><a href="${chooserPath}">Sign in with another host</a></p>`,
    );
  }

  async function signOut(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const accounts = sessionAccounts(req);
    const only = severalHosts ? ((await readForm(req)).get('host') ?? '') : '';
    const leaving = only === '' ? [...accounts.keys()] : accounts.has(only) ? [only] : [];
    for (const key of leaving) {
      const entry = hosts.byKey(key);
      const account = accounts.get(key);
      if (entry !== undefined && account !== undefined) forgetAccount(entry, account.person);
      accounts.delete(key);
    }
    const signInLink = `<p><a href="${severalHosts ? chooserPath : loginPath}">Sign in${severalHosts ? '' : ` with ${escapeHtml(label)}`}</a></p>`;
    const left = [...accounts.keys()].map((key) => hosts.byKey(key)?.names.label ?? key);
    sendHtml(
      res,
      200,
      'Signed out',
      `<p>${left.length === 0 ? 'You are signed out of GitQuire.' : leaving.length === 0 ? `You were not signed in with that host. Still signed in with ${escapeHtml(left.join(', '))}.` : `You are signed out of ${escapeHtml(hosts.byKey(only)?.names.label ?? only)}. Still signed in with ${escapeHtml(left.join(', '))}.`}</p>${signInLink}`,
      { 'Set-Cookie': sessionCookie(accounts) },
    );
  }

  function accountList(req: IncomingMessage): Record<string, unknown>[] {
    const accounts = sessionAccounts(req);
    return hosts.list().flatMap((entry) => {
      const mine = accounts.get(entry.key);
      return mine === undefined
        ? []
        : [
            {
              host: entry.key,
              label: entry.names.label,
              login: mine.person.login,
              principalId: personIdOn(entry.names, mine.person.id),
            },
          ];
    });
  }

  function handleAuth(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    search: string,
  ): void {
    const fail = (err: unknown, hostLabel: string): void => {
      deps.log.error({ err }, '[gitquire-door] sign-in callback failed');
      if (!res.headersSent) {
        sendHtml(
          res,
          502,
          'Sign-in failed',
          `<p>Could not reach ${escapeHtml(hostLabel)}. Try again in a moment.</p>`,
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    };
    if (severalHosts && path === chooserPath) {
      signInChooser(req, res, search);
      return;
    }
    for (const entry of hosts.list()) {
      if (path === entry.paths.login) {
        startLogin(res, search, 'sign-in', entry);
        return;
      }
      if (path === entry.paths.callback) {
        completeLogin(req, res, search, entry).catch((err: unknown) =>
          fail(err, entry.names.label),
        );
        return;
      }
    }
    const adding = hosts.list().find((entry) => entry.paths.addWiki === path);
    if (adding !== undefined) {
      if (sessionAccounts(req).size === 0) {
        needSignIn(req, res, `${path}${search}`);
        return;
      }
      startLogin(res, search, 'add', adding);
      return;
    }
    if (path === '/auth/logout') {
      if (req.method === 'POST' && !isSameOriginRequest(req, settings.externalUrl)) {
        sendJson(res, 403, { error: 'cross-origin' });
        return;
      }
      if (req.method === 'POST') {
        signOut(req, res).catch((err: unknown) => {
          deps.log.warn({ err }, '[gitquire-door] sign-out failed');
          if (!res.headersSent) sendJson(res, 400, { error: 'bad-request' });
        });
        return;
      }
      signOutPage(req, res);
      return;
    }
    if (path === '/auth/me') {
      const user = sessionUser(req);
      const accounts = severalHosts ? accountList(req) : undefined;
      if (user === undefined && (accounts === undefined || accounts.length === 0)) {
        sendJson(res, 401, {
          error: 'not-signed-in',
          signIn: severalHosts ? chooserPath : loginPath,
        });
        return;
      }
      sendJson(res, 200, {
        ...(user === undefined
          ? {}
          : {
              ...user,
              principalId: personIdOn(primary.names, user.id),
              serverAdmin: isServerAdmin(user),
            }),
        wikis: true,
        ...(accounts === undefined ? {} : { accounts, signIn: chooserPath }),
      });
      return;
    }
    sendJson(res, 404, { error: 'not-found' });
  }

  function wikiView(wiki: WikiRecord, admin: boolean): Record<string, unknown> {
    return {
      key: wiki.key,
      host: wiki.host,
      hostKey: hostKeyOf(wiki),
      hostLabel: hosts.of(wiki)?.names.label ?? wiki.host,
      fullName: wikiName(wiki),
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

  function unreadIn(seat: Seat, wiki: WikiRecord): number | undefined {
    if (deps.mentionCounts === undefined || wiki.state !== 'on') return undefined;
    try {
      return deps.mentionCounts.unread(
        seat.person,
        wiki,
        personIdOn(seat.entry.names, seat.person.id),
      );
    } catch (err) {
      deps.log.warn({ err, wiki: wiki.key }, '[gitquire-door] could not count mentions');
      return undefined;
    }
  }

  async function openableWikis(accounts: Accounts): Promise<ListedWithUnread[]> {
    const perHost = await Promise.all(
      hosts.list().map(async (entry): Promise<ListedWithUnread[]> => {
        const person = accounts.get(entry.key)?.person;
        if (person === undefined) return [];
        const seat: Seat = { entry, person };
        const listed = await withinDeadline(
          entry.access.wikisFor(person, wikisOf(entry), {
            serverAdmin: isAdminOn(entry, person),
          }),
          severalHosts ? (deps.listDeadlineMs ?? HOST_LIST_DEADLINE_MS) : Number.POSITIVE_INFINITY,
          () => {
            deps.log.warn(
              { host: entry.key },
              '[gitquire-door] a host did not answer in time; its wikis are left out of the list',
            );
            return [];
          },
        );
        return listed.map(({ wiki, admin }) => {
          const unread = unreadIn(seat, wiki);
          const base = { wiki, admin, seat };
          return unread === undefined ? base : { ...base, unread };
        });
      }),
    );
    return perHost.flat();
  }

  async function listWikis(accounts: Accounts): Promise<Record<string, unknown>> {
    const listed = await openableWikis(accounts);
    const fallback = defaultWiki();
    return {
      wikis: listed.map(({ wiki, admin, unread }) => ({
        ...wikiView(wiki, admin),
        ...(unread === undefined ? {} : { unread }),
      })),
      unread: listed.reduce((sum, { unread }) => sum + (unread ?? 0), 0),
      hosts: ownersSentence(),
      defaultWiki: fallback === undefined ? null : `${wikiPrefix(fallback)}/`,
      addWiki: addPath,
      addWikiPage: ADD_WIKI_PAGE,
      ...(severalHosts
        ? { accounts: accountsView(accounts), signInWith: signInWith(accounts) }
        : {}),
    };
  }

  function addableAnswer(seat: Seat): AddableAnswer | undefined {
    const user = seat.person;
    const { owners } = seat.entry;
    const entry = addable.get(slot(seat));
    if (entry === undefined || now() - entry.at > ADDABLE_MAX_AGE_MS) return undefined;
    const repos = (entry.repos ?? [])
      .filter((repo) => ownerAllowed(owners, repo))
      .map((repo): AddableView => {
        const existing = table.byId(seat.entry.key, repo.id);
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
      hosts: allowedOwnersSentence(owners),
      needsToken: seat.entry.settings.kind === 'forgejo',
      canAdd: seat.entry.settings.kind !== 'forgejo' || isAdminOn(seat.entry, user),
    };
  }

  async function addWiki(seat: Seat, id: unknown, given: unknown): Promise<Outcome> {
    const user = seat.person;
    const { owners, forgejoTokens, access } = seat.entry;
    const label = seat.entry.names.label;
    const addPath = seat.entry.paths.addWiki;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      return {
        status: 400,
        body: { error: 'invalid-id', message: 'Send the repository id as a number.' },
      };
    }
    const entry = addable.get(slot(seat));
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
    if (!ownerAllowed(owners, repo)) {
      return {
        status: 403,
        body: { error: 'owner-not-allowed', message: allowedOwnersSentence(owners) },
      };
    }
    const existing = table.byId(seat.entry.key, repo.id);
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
    let sameName = table.byAddress(seat.entry.key, repo.owner, repo.name);
    if (sameName?.current === true) {
      await processes.check(sameName.wiki).catch(() => undefined);
      sameName = table.byAddress(seat.entry.key, repo.owner, repo.name);
    }
    if (sameName?.current === true) {
      const gone = sameName.wiki.state === 'disconnected' && sameName.wiki.reason === 'gone';
      deps.log.warn(
        {
          repo: `${repo.owner}/${repo.name}`,
          id: repo.id,
          wiki: sameName.wiki.key,
          gone,
          by: user.login,
        },
        '[gitquire-door] Add a wiki refused a name an existing wiki still has',
      );
      return {
        status: 409,
        body: {
          error: 'name-in-use',
          message: gone
            ? `The wiki of a repository that no longer exists on ${label} still has the name ${repo.owner}/${repo.name}, so this repository cannot become a wiki under it. A server administrator can remove the old wiki on the wiki list (Remove the wiki); then try again.`
            : `A wiki already has the name ${repo.owner}/${repo.name}, and ${label} could not tell GitQuire its new name just now. Try again in a few minutes.`,
        },
      };
    }
    const key = wikiKey(repo, seat.entry.key);
    if (forgejoTokens !== undefined) {
      if (!isAdminOn(seat.entry, user)) {
        return {
          status: 403,
          body: {
            error: 'server-admin-only',
            message: 'On Forgejo, a server administrator adds a wiki and enters its token.',
          },
        };
      }
      const token = typeof given === 'string' ? given.trim() : '';
      if (token === '' || forgejoTokens.isBotToken(token)) {
        return {
          status: 400,
          body: {
            error: 'token-required',
            message:
              "Enter a token of GitQuire's account limited to this repository, with write:repository.",
          },
        };
      }
      const health = await forgejoTokens.check(repo, token);
      if (health !== 'ok') {
        return refusalOutcome(label, health);
      }
      forgejoTokens.save(key, token);
    }
    pinAllowedOwner(owners, repo);
    const wiki = table.add(repo, user.login, now(), seat.entry.key);
    access.learn(user, wiki, 'admin');
    deps.log.info(
      { wiki: wiki.key, repo: `${wiki.owner}/${wiki.name}`, by: user.login },
      '[gitquire-door] a repository became a wiki',
    );
    return { status: 201, body: { wiki: wikiView(wiki, true) } };
  }

  function addSeat(accounts: Accounts, chosen: string | null | undefined): Seat | undefined {
    if (chosen !== null && chosen !== undefined && chosen !== '') {
      const entry = hosts.byKey(chosen);
      const person = entry === undefined ? undefined : accounts.get(entry.key)?.person;
      return entry === undefined || person === undefined ? undefined : { entry, person };
    }
    const signed = hosts.list().filter((entry) => accounts.has(entry.key));
    const only = signed.length === 1 ? signed[0] : undefined;
    const person = only === undefined ? undefined : accounts.get(only.key)?.person;
    return only === undefined || person === undefined ? undefined : { entry: only, person };
  }

  function addPageFor(entry: DoorHostEntry): string {
    return severalHosts ? `${ADD_WIKI_PAGE}?host=${encodeURIComponent(entry.key)}` : ADD_WIKI_PAGE;
  }

  async function makeWikiAt(
    req: IncomingMessage,
    res: ServerResponse,
    accounts: Accounts,
  ): Promise<void> {
    const body = await readJson(req);
    const seat = addSeat(accounts, typeof body.host === 'string' ? body.host : undefined);
    if (seat === undefined) {
      sendJson(res, severalHosts ? 400 : 404, {
        error: severalHosts ? 'host-required' : 'not-found',
        ...(severalHosts
          ? { message: 'Name the host ("host") you are signed in with.', hosts: [...hostKeys()] }
          : {}),
      });
      return;
    }
    const outcome = await addWiki(seat, body.id, body.token);
    sendJson(res, outcome.status, outcome.body);
  }

  function hostKeys(): string[] {
    return hosts.list().map((entry) => entry.key);
  }

  function addHostChoice(res: ServerResponse, accounts: Accounts): void {
    const rows = hosts
      .list()
      .map((entry) =>
        accounts.has(entry.key)
          ? `<li><a href="${escapeHtml(addPageFor(entry))}">Add a wiki from ${escapeHtml(entry.names.label)}</a></li>`
          : `<li><a href="${escapeHtml(`${entry.paths.addWiki}?next=${encodeURIComponent(addPageFor(entry))}`)}">Sign in with ${escapeHtml(entry.names.label)} to add a wiki from it</a></li>`,
      )
      .join('');
    sendHtml(
      res,
      200,
      'Add a wiki',
      `<p>Which Git host is the repository on?</p><ul>${rows}</ul><p><a href="/">Your wikis</a></p>`,
    );
  }

  function adminSeatOf(
    accounts: Accounts,
    key: string,
  ): { seat: Seat; wiki: WikiRecord } | undefined {
    const wiki = table.byKey(key);
    const seat = wiki === undefined ? undefined : seatFor(accounts, wiki);
    if (wiki === undefined || seat === undefined || !isAdminOn(seat.entry, seat.person)) {
      return undefined;
    }
    return { seat, wiki };
  }

  async function newToken(accounts: Accounts, key: string, given: unknown): Promise<Outcome> {
    const found = adminSeatOf(accounts, key);
    const checks = found?.seat.entry.forgejoTokens;
    if (found === undefined || checks === undefined) {
      return { status: 404, body: { error: 'not-found' } };
    }
    const { wiki } = found;
    const token = typeof given === 'string' ? given.trim() : '';
    if (token === '' || checks.isBotToken(token)) {
      return { status: 400, body: { error: 'token-required' } };
    }
    const health = await checks.check(wiki, token);
    if (health !== 'ok') return refusalOutcome(found.seat.entry.names.label, health);
    checks.save(key, token);
    await processes.check(wiki);
    return { status: 200, body: { wiki: wikiView(wiki, true) } };
  }

  async function replaceToken(
    req: IncomingMessage,
    res: ServerResponse,
    accounts: Accounts,
    key: string,
  ): Promise<void> {
    if (adminSeatOf(accounts, key)?.seat.entry.forgejoTokens === undefined) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const body = await readJson(req);
    const outcome = await newToken(accounts, key, body.token);
    sendJson(res, outcome.status, outcome.body);
  }

  function handleApi(req: IncomingMessage, res: ServerResponse, path: string): void {
    const accounts = sessionAccounts(req);
    if (accounts.size === 0) {
      sendJson(res, 401, {
        error: 'not-signed-in',
        signIn: severalHosts ? chooserPath : loginPath,
      });
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
      listWikis(accounts).then((body) => sendJson(res, 200, body), fail);
      return;
    }
    const tokenRoute = new RegExp(`^${FRONT_DOOR_API}/wikis/([a-z0-9-]+)/token$`).exec(path);
    if (tokenRoute !== null && method === 'PUT') {
      replaceToken(req, res, accounts, tokenRoute[1] as string).catch(fail);
      return;
    }
    const chosen = new URL(req.url ?? '/', 'http://door.invalid').searchParams.get('host');
    if (path === `${FRONT_DOOR_API}/wikis` && method === 'POST') {
      makeWikiAt(req, res, accounts).catch(fail);
      return;
    }
    const seat = addSeat(accounts, chosen);
    if (seat === undefined) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    if (path === `${FRONT_DOOR_API}/addable` && method === 'GET') {
      const answer = addableAnswer(seat);
      if (answer === undefined) {
        sendJson(res, 409, { error: 'sign-in-again', signIn: seat.entry.paths.addWiki });
      } else {
        sendJson(res, 200, answer);
      }
      return;
    }
    sendJson(res, 404, { error: 'not-found' });
  }

  function seesWhy(seat: Seat, wiki: WikiRecord): boolean {
    return seat.entry.access.wasAdmin(seat.person, wiki) || isAdminOn(seat.entry, seat.person);
  }

  function closedAnswer(
    req: IncomingMessage,
    res: ServerResponse,
    wiki: WikiRecord,
    seat: Seat,
    decision: Exclude<OpenDecision, { open: true }>,
  ): void {
    if (decision.why === 'unreachable') {
      deps.log.info(
        {
          wiki: wiki.key,
          login: seat.person.login,
          ...(severalHosts ? { host: seat.entry.key } : {}),
        },
        `[gitquire-door] ${seat.entry.names.label} cannot be reached to check a person's access; answered as no wiki`,
      );
    }
    if (decision.why !== 'disconnected' || !seesWhy(seat, wiki)) {
      notAWiki(req, res);
      return;
    }
    const repo = wikiName(wiki);
    if (!wantsHtml(req)) {
      sendJson(res, 403, { error: 'disconnected', reason: wiki.reason ?? null });
      return;
    }
    sendHtml(
      res,
      403,
      'Wiki unavailable',
      `<p>The wiki <code>${escapeHtml(repo)}</code> is disconnected.</p><p>${escapeHtml(REASON_TEXT[wiki.reason ?? ''] ?? '')}</p><p><a href="/">Your wikis</a></p>`,
    );
  }

  function notAWiki(req: IncomingMessage, res: ServerResponse): void {
    const sentence = ownersSentence();
    const reachable = severalHosts ? 'a Git host' : label;
    if (wantsHtml(req)) {
      sendHtml(
        res,
        404,
        'No wiki here',
        `<p>There is no wiki at this address.</p><p>If it is a repository under an allowed owner that is not a wiki yet, one of its administrators can make it one at <a href="${ADD_WIKI_PAGE}">Add a wiki</a>.</p><p>${escapeHtml(sentence)}</p><p>If you expected a wiki here, ${escapeHtml(reachable)} may not be reachable right now; try again in a moment.</p><p><a href="/">Your wikis</a></p>`,
      );
    } else {
      sendJson(res, 404, { error: 'not-a-wiki', hosts: sentence });
    }
  }

  function noteSeen(person: string, login: string): void {
    try {
      deps.seen?.(person, login);
    } catch (err) {
      deps.log.warn({ err, login }, '[gitquire-mail] could not note the visit');
    }
  }

  function forwardHeaders(
    user: DoorSessionUser,
    wiki: WikiRecord,
    admin: boolean,
    view: string | undefined,
    agentFeatures?: string,
  ): Record<string, string> {
    const secret = processes.secretOf(wiki.key) ?? '';
    const entry = hosts.of(wiki);
    if (entry !== undefined) noteSeen(personIdOn(entry.names, user.id), user.login);
    return {
      [INTERNAL_REQUEST_HEADER]: secret,
      [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser({
        ...user,
        ...(admin ? { repoAdmin: true } : {}),
      }),
      [FORWARDED_PREFIX_HEADER]: wikiPrefix(wiki),
      ...(deps.tickets === undefined || entry === undefined
        ? {}
        : {
            [PERSON_TICKET_HEADER]: deps.tickets.issue(
              wiki.key,
              personIdOn(entry.names, user.id),
              user.login,
            ),
          }),
      ...(view === undefined || view === '' ? {} : { [FORWARDED_VIEW_HEADER]: view }),
      ...(agentFeatures === undefined ? {} : { [FORWARDED_AGENTS_HEADER]: agentFeatures }),
      ...(agentFeatures === undefined || entry === undefined
        ? {}
        : { [FORWARDED_AGENTS_HOST_HEADER]: entry.key }),
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
    seat: Seat,
    wiki: WikiRecord,
    path: string,
    view: string | undefined,
    decided?: OpenDecision,
  ): Promise<void> {
    const user = seat.person;
    const decision = decided ?? (await decide(seat, wiki));
    if (!decision.open) {
      closedAnswer(req, res, wiki, seat, decision);
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
    const asksForMe = rawPathAndSearch(path).path === '/auth/me';
    proxyRequest(req, res, socket, {
      extraHeaders: forwardHeaders(
        user,
        wiki,
        decision.admin,
        view,
        asksForMe ? deps.agents?.features(seat.entry.key, user) : undefined,
      ),
      unavailable: { error: 'wiki-unavailable', message: 'The wiki is not reachable.' },
      rewriteHeaders: (headers) =>
        translateResponseHeaders(headers, { prefix: wikiPrefix(wiki), key: wiki.key, secure }),
    });
  }

  function resolveWiki(address: WikiAddress | undefined): ResolvedAddress | undefined {
    if (address === undefined || hosts.byKey(address.hostKey) === undefined) return undefined;
    const match = table.byAddress(address.hostKey, address.owner, address.name);
    return match === undefined
      ? undefined
      : { ...match, rest: address.rest, search: address.search };
  }

  async function homePage(res: ServerResponse, accounts: Accounts): Promise<void> {
    const listed = (await openableWikis(accounts)).map((row) => ({
      ...row,
      canRemove: isAdminOn(row.seat.entry, row.seat.person),
      canReplaceToken:
        row.seat.entry.forgejoTokens !== undefined && isAdminOn(row.seat.entry, row.seat.person),
    }));
    sendHtml(
      res,
      200,
      'Your wikis',
      homeBody({
        rows: listed,
        hosts: ownersSentence(),
        canReplaceToken: false,
        canRemove: false,
      }),
    );
  }

  async function addWikiHelp(entry: DoorHostEntry): Promise<AddWikiHelp> {
    if (entry.addWikiHelp === undefined) return {};
    return entry.addWikiHelp().catch((): AddWikiHelp => ({}));
  }

  function askHostAgain(res: ServerResponse, seat: Seat, adding: boolean): void {
    const user = seat.person;
    const label = seat.entry.names.label;
    const addPath = seat.entry.paths.addWiki;
    const entry = addable.get(slot(seat));
    deps.log.info(
      {
        login: user.login,
        reason: entry === undefined ? 'no-list-since-sign-in' : 'list-expired',
        ...(entry === undefined ? {} : { ageMinutes: Math.floor((now() - entry.at) / 60_000) }),
        keptMinutes,
        adding,
      },
      `[gitquire-door] Add a wiki asks ${label} again for the repositories`,
    );
    if (entry !== undefined || adding) renewed.add(slot(seat));
    redirect(res, `${addPath}?next=${encodeURIComponent(addPageFor(seat.entry))}`);
  }

  function takePendingAdd(seat: Seat): PendingAdd | undefined {
    const pending = pendingAdds.get(slot(seat));
    pendingAdds.delete(slot(seat));
    if (pending === undefined || now() - pending.at > PENDING_ADD_MAX_AGE_MS) return undefined;
    return pending;
  }

  async function addWikiPage(res: ServerResponse, seat: Seat, failed?: Outcome): Promise<void> {
    const label = seat.entry.names.label;
    const addPath = seat.entry.paths.addWiki;
    const answer = addableAnswer(seat);
    const reload = `${addPath}?next=${encodeURIComponent(addPageFor(seat.entry))}`;
    if (answer === undefined) {
      askHostAgain(res, seat, false);
      return;
    }
    const pending = failed === undefined ? takePendingAdd(seat) : undefined;
    if (pending !== undefined) {
      const outcome = await addWiki(seat, pending.id, pending.token);
      if (outcome.status === 201) {
        renewed.delete(slot(seat));
        const wiki = outcome.body.wiki as { address: string };
        res.writeHead(303, { Location: wiki.address, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      failed = outcome;
    }
    const notice = renewed.delete(slot(seat))
      ? `GitQuire asked ${label} again for your repositories: the list is kept for ${keptMinutes} minutes.${pending === undefined ? '' : ' Your request to make a repository a wiki was carried over.'}`
      : undefined;
    const message = failed?.body.message;
    sendHtml(
      res,
      failed?.status ?? 200,
      'Add a wiki',
      addWikiBody({
        host: seat.entry.settings.kind,
        label,
        state: answer.state,
        repos: answer.repos,
        hosts: answer.hosts,
        canAdd: answer.canAdd,
        needsToken: answer.needsToken,
        help: await addWikiHelp(seat.entry),
        reload,
        keptMinutes,
        ...(typeof message === 'string' ? { message } : {}),
        ...(notice === undefined ? {} : { notice }),
        ...(severalHosts ? { hostKey: seat.entry.key } : {}),
      }),
    );
  }

  async function addWikiFormAt(
    req: IncomingMessage,
    res: ServerResponse,
    accounts: Accounts,
  ): Promise<void> {
    const form = await readForm(req);
    const seat = addSeat(accounts, form.get('host'));
    if (seat === undefined) {
      addHostChoice(res, accounts);
      return;
    }
    await addWikiForm(form, res, seat);
  }

  async function addWikiForm(
    form: URLSearchParams,
    res: ServerResponse,
    seat: Seat,
  ): Promise<void> {
    const raw = form.get('id') ?? '';
    const id = /^[0-9]{1,15}$/.test(raw) ? Number(raw) : undefined;
    const outcome = await addWiki(seat, id, form.get('token') ?? undefined);
    if (outcome.status === 201) {
      const wiki = outcome.body.wiki as { address: string };
      res.writeHead(303, { Location: wiki.address, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (outcome.body.error === 'sign-in-again' && id !== undefined) {
      const token = form.get('token');
      pendingAdds.set(slot(seat), {
        id,
        token: token === null || token === '' ? undefined : token,
        at: now(),
      });
      askHostAgain(res, seat, true);
      return;
    }
    await addWikiPage(res, seat, outcome);
  }

  async function removeWiki(accounts: Accounts, key: string): Promise<Outcome> {
    const found = adminSeatOf(accounts, key);
    if (found === undefined) return { status: 404, body: { error: 'not-found' } };
    const { wiki } = found;
    const user = found.seat.person;
    if (wiki.state === 'on') {
      return {
        status: 409,
        body: {
          error: 'still-connected',
          message: 'Only a disconnected wiki can be removed.',
        },
      };
    }
    await processes.retire(key);
    const dir = wikiDir(settings.dataDir, wiki);
    let keptIn: string | undefined;
    if (existsSync(dir)) {
      const removedDir = join(settings.dataDir, 'wikis-removed');
      mkdirSync(removedDir, { recursive: true });
      keptIn = join(removedDir, `${key}-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`);
      renameSync(dir, keptIn);
    }
    table.remove(key);
    found.seat.entry.forgejoTokens?.forget(key);
    deps.log.warn(
      {
        wiki: key,
        repo: `${wiki.owner}/${wiki.name}`,
        reason: wiki.reason,
        by: user.login,
        keptIn,
      },
      '[gitquire-door] a disconnected wiki was removed',
    );
    return { status: 200, body: { removed: key, ...(keptIn === undefined ? {} : { keptIn }) } };
  }

  async function removeForm(
    req: IncomingMessage,
    res: ServerResponse,
    accounts: Accounts,
  ): Promise<void> {
    const form = await readForm(req);
    if (form.get('confirm') !== 'yes') {
      sendHtml(
        res,
        400,
        'Wiki not removed',
        '<p>Tick the box to confirm the removal.</p><p><a href="/">Your wikis</a></p>',
      );
      return;
    }
    const outcome = await removeWiki(accounts, form.get('key') ?? '');
    if (outcome.status === 200) {
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (outcome.status === 404) {
      notAWiki(req, res);
      return;
    }
    const message = outcome.body.message;
    sendHtml(
      res,
      outcome.status,
      'Wiki not removed',
      `<p>${escapeHtml(typeof message === 'string' ? message : 'The wiki was not removed.')}</p><p><a href="/">Your wikis</a></p>`,
    );
  }

  async function tokenForm(
    req: IncomingMessage,
    res: ServerResponse,
    accounts: Accounts,
  ): Promise<void> {
    const form = await readForm(req);
    const outcome = await newToken(accounts, form.get('key') ?? '', form.get('token') ?? undefined);
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
    accounts: Accounts,
    fail: (err: unknown) => void,
  ): boolean {
    if (path !== ADD_WIKI_PAGE && path !== ADD_WIKI_TOKEN_FORM && path !== REMOVE_WIKI_FORM) {
      return false;
    }
    const method = req.method ?? 'GET';
    if (accounts.size === 0) {
      needSignIn(req, res, ADD_WIKI_PAGE);
      return true;
    }
    const chosen = new URL(req.url ?? '/', 'http://door.invalid').searchParams.get('host');
    if (path === ADD_WIKI_PAGE && (method === 'GET' || method === 'HEAD')) {
      const seat = addSeat(accounts, chosen);
      if (seat === undefined) addHostChoice(res, accounts);
      else addWikiPage(res, seat).catch(fail);
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
    if (path === ADD_WIKI_PAGE) {
      addWikiFormAt(req, res, accounts).catch(fail);
      return true;
    }
    (path === REMOVE_WIKI_FORM ? removeForm : tokenForm)(req, res, accounts).catch(fail);
    return true;
  }

  function answeredForPerson(
    req: IncomingMessage,
    res: ServerResponse,
    seat: Seat,
    rest: string,
  ): boolean {
    const routes = deps.personRoutes;
    if (routes === undefined) return false;
    const path = rawPathAndSearch(rest).path;
    if (!routes.handles(path, req.method ?? 'GET')) return false;
    routes.handle(
      req,
      res,
      {
        person: personIdOn(seat.entry.names, seat.person.id),
        login: seat.person.login,
        hostLabel: seat.entry.names.label,
      },
      path,
    );
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
    const accounts = sessionAccounts(req);
    const signedIn = accounts.size > 0;
    const address = parseWikiAddress(req.url);
    const viewFor = (key: string): string | undefined => {
      const value = readCookie(req, viewCookieName(key));
      return isSlug(value) ? value : undefined;
    };
    const fail = (err: unknown): void => {
      deps.log.error({ err, path: rawPath }, '[gitquire-door] request failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'front-door-error' });
      else if (!res.writableEnded) res.destroy();
    };

    if (address !== undefined) {
      if (
        deps.agents !== undefined &&
        (address.rest === '/mcp' || address.rest.startsWith('/mcp/'))
      ) {
        sendJson(res, 404, {
          error: 'mcp-at-root',
          mcp: new URL(mcpPathFor(address.hostKey), settings.externalUrl).toString(),
          message:
            'AI assistants connect to the address of the Git host named in the wiki address and name the wiki in each call.',
        });
        return;
      }
      const match = resolveWiki(address);
      if (!signedIn) {
        needSignIn(req, res, `${rawPath}${search}`);
        return;
      }
      const seat = match === undefined ? undefined : seatFor(accounts, match.wiki);
      if (match === undefined || seat === undefined) {
        notAWiki(req, res);
        return;
      }
      const view = viewFor(match.wiki.key);
      decide(seat, match.wiki)
        .then((decision) => {
          if (decision.open && (!match.current || match.rest === '')) {
            const reading = req.method === 'GET' || req.method === 'HEAD';
            res.writeHead(match.current ? 302 : reading ? 301 : 308, {
              Location: `${wikiPrefix(match.wiki)}${match.rest === '' ? '/' : match.rest}${match.search}`,
              'Cache-Control': 'no-store',
            });
            res.end();
            return undefined;
          }
          if (decision.open && answeredForPerson(req, res, seat, match.rest)) return undefined;
          return toWiki(req, res, seat, match.wiki, `${match.rest}${match.search}`, view, decision);
        })
        .catch(fail);
      return;
    }

    const { path } = pathOf(req);
    if (deps.agents?.handle(req, res, path, search) === true) return;
    if (path.startsWith('/auth/')) {
      handleAuth(req, res, path, search);
      return;
    }
    if (path === FRONT_DOOR_API || path.startsWith(`${FRONT_DOOR_API}/`)) {
      handleApi(req, res, path);
      return;
    }
    if (handlePages(req, res, path, accounts, fail)) return;
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!signedIn) {
        needSignIn(req, res, '/');
        return;
      }
      homePage(res, accounts).catch(fail);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const match = resolveWiki(refererAddress(req, settings.externalUrl.origin));
      const fromSeat = match === undefined ? undefined : seatFor(accounts, match.wiki);
      const withoutReferer = (): void => {
        if (wantsHtml(req) && !path.startsWith('/api/')) notAWiki(req, res);
        else sendJson(res, 404, { error: 'wiki-address-required' });
      };
      if (fromSeat !== undefined && match?.current === true) {
        decide(fromSeat, match.wiki)
          .then((decision) => {
            if (!decision.open) {
              withoutReferer();
              return undefined;
            }
            if (answeredForPerson(req, res, fromSeat, rawPath)) return undefined;
            return toWiki(
              req,
              res,
              fromSeat,
              match.wiki,
              `${rawPath}${search}`,
              viewFor(match.wiki.key),
              decision,
            );
          })
          .catch(fail);
        return;
      }
      withoutReferer();
      return;
    }
    sendJson(res, 404, { error: 'wiki-address-required' });
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const accounts = sessionAccounts(req);
    const address = parseWikiAddress(req.url);
    const cookies = { headers: { cookie: req.headers.cookie } } as IncomingMessage;
    stripBrowserHeaders(req);
    if (address === undefined || address.rest === '') {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    if (accounts.size === 0) {
      refuseUpgrade(socket, '401 Unauthorized');
      return;
    }
    const resolved = resolveWiki(address);
    if (resolved === undefined || resolved.rest === '') {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    const match = resolved;
    const seat = seatFor(accounts, match.wiki);
    if (!match.current || seat === undefined) {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    const wiki = match.wiki;
    const user = seat.person;
    const cookieView = readCookie(cookies, viewCookieName(wiki.key));
    const viewSlug = isSlug(cookieView) ? cookieView : undefined;
    void (async () => {
      const decision = await decide(seat, wiki);
      if (!decision.open) {
        refuseUpgrade(socket, '404 Not Found');
        return;
      }
      const target = await processes.ensure(wiki);
      const release = processes.hold(wiki.key);
      const connection: OpenConnection = { seat, key: wiki.key, socket };
      connections.add(connection);
      req.url = `${match.rest}${match.search}`;
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
            : await decide(connection.seat, wiki);
        if (decision.open || decision.why === 'unreachable') return;
        deps.log.info(
          { wiki: connection.key, login: connection.seat.person.login, why: decision.why },
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
    sessionUser,
    setReady: (value) => {
      ready = value;
    },
  };
}
