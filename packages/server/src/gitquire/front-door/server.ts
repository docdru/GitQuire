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
import { proxyRequest, proxyUpgrade } from '../process-pool/forward.ts';
import {
  encodeProxiedUser,
  FORWARDED_AGENTS_HEADER,
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
} from './translate.ts';
import { WikiClosedError, type WikiProcesses } from './wiki-processes.ts';
import { type WikiRecord, type WikiTable, wikiDir, wikiKey, wikiPrefix } from './wiki-table.ts';

const DOOR_SESSION_COOKIE = 'gq_session';
const DOOR_STATE_COOKIE = 'gq_oauth_state';
const STATE_MAX_AGE_SECONDS = 600;
export const ADDABLE_MAX_AGE_MS = 30 * 60 * 1000;
export const PENDING_ADD_MAX_AGE_MS = 10 * 60 * 1000;
export const RECHECK_MS = 60 * 1000;
const MAX_JSON_BYTES = 16 * 1024;
const FRONT_DOOR_API = '/api/front-door';
const OLD_ADDRESS_SCRIPT = '/_door/old-address.js';

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
  agents?: Pick<DoorAgents, 'handle' | 'features'>;
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
  sessionUser: (req: IncomingMessage) => HostPerson | undefined;
}

interface OpenConnection {
  person: DoorPerson;
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
  const { host, access, owners, forgejoTokens } = primary;
  const now = deps.now ?? Date.now;
  const randomState = deps.randomState ?? (() => randomBytes(24).toString('base64url'));
  const secure = settings.externalUrl.protocol === 'https:';
  const label = primary.names.label;
  const loginPath = primary.paths.login;
  const addPath = primary.paths.addWiki;
  const addable = new Map<number, AddableEntry>();
  const pendingAdds = new Map<number, PendingAdd>();
  const renewed = new Set<number>();
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

  function sessionUser(req: IncomingMessage): DoorSessionUser | undefined {
    return sessionAccounts(req).get(primary.key)?.person;
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

  function primaryWikis(): WikiRecord[] {
    return table.list().filter((wiki) => hosts.of(wiki) === primary);
  }

  function decide(person: DoorPerson, wiki: WikiRecord): Promise<OpenDecision> {
    if (hosts.of(wiki) !== primary) return Promise.resolve({ open: false, why: 'no-access' });
    return access.decide(person, wiki);
  }

  function isServerAdmin(user: DoorSessionUser): boolean {
    return primary.settings.serverAdmins.has(user.login.toLowerCase());
  }

  function defaultWiki(): WikiRecord | undefined {
    const wanted = settings.defaultWiki;
    if (wanted === undefined) return undefined;
    const match = table.byAddress(wanted.owner, wanted.name);
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
    await Promise.all([
      entry === primary ? access.signIn(person, token, primaryWikis()) : Promise.resolve(),
      stored.purpose === 'add' && entry === primary
        ? rememberAddable(person, token)
        : Promise.resolve(),
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
    if (entry === primary) {
      addable.delete(person.id);
      pendingAdds.delete(person.id);
      renewed.delete(person.id);
    }
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
          `<li>${escapeHtml(entry.names.label)}: <strong>@${escapeHtml(mine.person.login)}</strong> <form method="post" action="/auth/logout" style="display:inline"><input type="hidden" name="host" value="${escapeHtml(entry.key)}"><button type="submit">Sign out of ${escapeHtml(entry.names.label)}</button></form></li>`,
        ];
      })
      .join('');
    sendHtml(
      res,
      200,
      'Sign out',
      `${rows === '' ? '<p>You are not signed in.</p>' : `<ul>${rows}</ul>${agentsLink}<form method="post" action="/auth/logout"><button type="submit">Sign out of all</button></form>`}<p><a href="${chooserPath}">Sign in with another host</a></p>`,
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
    if (path === addPath) {
      if (sessionUser(req) === undefined) {
        needSignIn(req, res, `${path}${search}`);
        return;
      }
      startLogin(res, search, 'add', primary);
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
    const entry = hosts.of(wiki);
    if (deps.mentionCounts === undefined || wiki.state !== 'on' || entry === undefined) {
      return undefined;
    }
    try {
      return deps.mentionCounts.unread(user, wiki, personIdOn(entry.names, user.id));
    } catch (err) {
      deps.log.warn({ err, wiki: wiki.key }, '[gitquire-door] could not count mentions');
      return undefined;
    }
  }

  async function openableWikis(user: DoorSessionUser): Promise<ListedWithUnread[]> {
    const listed = await access.wikisFor(user, primaryWikis(), {
      serverAdmin: isServerAdmin(user),
    });
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
      hosts: allowedOwnersSentence(owners),
      defaultWiki: fallback === undefined ? null : `${wikiPrefix(fallback)}/`,
      addWiki: addPath,
      addWikiPage: ADD_WIKI_PAGE,
    };
  }

  function addableAnswer(user: DoorSessionUser): AddableAnswer | undefined {
    const entry = addable.get(user.id);
    if (entry === undefined || now() - entry.at > ADDABLE_MAX_AGE_MS) return undefined;
    const repos = (entry.repos ?? [])
      .filter((repo) => ownerAllowed(owners, repo))
      .map((repo): AddableView => {
        const existing = table.byId(primary.key, repo.id);
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
      needsToken: primary.settings.kind === 'forgejo',
      canAdd: primary.settings.kind !== 'forgejo' || isServerAdmin(user),
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
    if (!ownerAllowed(owners, repo)) {
      return {
        status: 403,
        body: { error: 'owner-not-allowed', message: allowedOwnersSentence(owners) },
      };
    }
    const existing = table.byId(primary.key, repo.id);
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
    let sameName = table.byAddress(repo.owner, repo.name);
    if (sameName?.current === true) {
      await processes.check(sameName.wiki).catch(() => undefined);
      sameName = table.byAddress(repo.owner, repo.name);
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
    const key = wikiKey(repo, primary.key);
    if (forgejoTokens !== undefined) {
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
    const wiki = table.add(repo, user.login, now(), primary.key);
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
    if (!isServerAdmin(user) || forgejoTokens === undefined) {
      return { status: 404, body: { error: 'not-found' } };
    }
    const wiki = table.byKey(key);
    if (wiki === undefined || hosts.of(wiki) !== primary) {
      return { status: 404, body: { error: 'not-found' } };
    }
    const token = typeof given === 'string' ? given.trim() : '';
    if (token === '' || forgejoTokens.isBotToken(token)) {
      return { status: 400, body: { error: 'token-required' } };
    }
    const health = await forgejoTokens.check(wiki, token);
    if (health !== 'ok') return refusalOutcome(label, health);
    forgejoTokens.save(key, token);
    await processes.check(wiki);
    return { status: 200, body: { wiki: wikiView(wiki, true) } };
  }

  async function replaceToken(
    req: IncomingMessage,
    res: ServerResponse,
    user: DoorSessionUser,
    key: string,
  ): Promise<void> {
    if (!isServerAdmin(user) || forgejoTokens === undefined || table.byKey(key) === undefined) {
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

  function seesWhy(user: DoorSessionUser, wiki: WikiRecord): boolean {
    return access.wasAdmin(user, wiki) || isServerAdmin(user);
  }

  function closedAnswer(
    req: IncomingMessage,
    res: ServerResponse,
    wiki: WikiRecord,
    user: DoorSessionUser,
    decision: Exclude<OpenDecision, { open: true }>,
  ): void {
    if (decision.why === 'unreachable') {
      deps.log.info(
        { wiki: wiki.key, login: user.login },
        `[gitquire-door] ${label} cannot be reached to check a person's access; answered as no wiki`,
      );
    }
    if (decision.why !== 'disconnected' || !seesWhy(user, wiki)) {
      notAWiki(req, res);
      return;
    }
    const repo = `${wiki.owner}/${wiki.name}`;
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
    const sentence = allowedOwnersSentence(owners);
    if (wantsHtml(req)) {
      sendHtml(
        res,
        404,
        'No wiki here',
        `<p>There is no wiki at this address.</p><p>If it is a repository under an allowed owner that is not a wiki yet, one of its administrators can make it one at <a href="${ADD_WIKI_PAGE}">Add a wiki</a>.</p><p>${escapeHtml(sentence)}</p><p>If you expected a wiki here, ${escapeHtml(label)} may not be reachable right now; try again in a moment.</p><p><a href="/">Your wikis</a></p>`,
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
    agentFeatures?: string,
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
      ...(agentFeatures === undefined ? {} : { [FORWARDED_AGENTS_HEADER]: agentFeatures }),
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
    decided?: OpenDecision,
  ): Promise<void> {
    const decision = decided ?? (await decide(user, wiki));
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
    const asksForMe = rawPathAndSearch(path).path === '/auth/me';
    proxyRequest(req, res, socket, {
      extraHeaders: forwardHeaders(
        user,
        wiki,
        decision.admin,
        view,
        asksForMe ? deps.agents?.features(user) : undefined,
      ),
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
        hosts: allowedOwnersSentence(owners),
        canReplaceToken: forgejoTokens !== undefined && isServerAdmin(user),
        canRemove: isServerAdmin(user),
        scriptPath: OLD_ADDRESS_SCRIPT,
      }),
    );
  }

  async function addWikiHelp(): Promise<AddWikiHelp> {
    if (primary.addWikiHelp === undefined) return {};
    return primary.addWikiHelp().catch((): AddWikiHelp => ({}));
  }

  function askHostAgain(res: ServerResponse, user: DoorSessionUser, adding: boolean): void {
    const entry = addable.get(user.id);
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
    if (entry !== undefined || adding) renewed.add(user.id);
    redirect(res, `${addPath}?next=${encodeURIComponent(ADD_WIKI_PAGE)}`);
  }

  function takePendingAdd(user: DoorSessionUser): PendingAdd | undefined {
    const pending = pendingAdds.get(user.id);
    pendingAdds.delete(user.id);
    if (pending === undefined || now() - pending.at > PENDING_ADD_MAX_AGE_MS) return undefined;
    return pending;
  }

  async function addWikiPage(
    res: ServerResponse,
    user: DoorSessionUser,
    failed?: Outcome,
  ): Promise<void> {
    const answer = addableAnswer(user);
    const reload = `${addPath}?next=${encodeURIComponent(ADD_WIKI_PAGE)}`;
    if (answer === undefined) {
      askHostAgain(res, user, false);
      return;
    }
    const pending = failed === undefined ? takePendingAdd(user) : undefined;
    if (pending !== undefined) {
      const outcome = await addWiki(user, pending.id, pending.token);
      if (outcome.status === 201) {
        renewed.delete(user.id);
        const wiki = outcome.body.wiki as { address: string };
        res.writeHead(303, { Location: wiki.address, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      failed = outcome;
    }
    const notice = renewed.delete(user.id)
      ? `GitQuire asked ${label} again for your repositories: the list is kept for ${keptMinutes} minutes.${pending === undefined ? '' : ' Your request to make a repository a wiki was carried over.'}`
      : undefined;
    const message = failed?.body.message;
    sendHtml(
      res,
      failed?.status ?? 200,
      'Add a wiki',
      addWikiBody({
        host: primary.settings.kind,
        label,
        state: answer.state,
        repos: answer.repos,
        hosts: answer.hosts,
        canAdd: answer.canAdd,
        needsToken: answer.needsToken,
        help: await addWikiHelp(),
        reload,
        keptMinutes,
        ...(typeof message === 'string' ? { message } : {}),
        ...(notice === undefined ? {} : { notice }),
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
    if (outcome.body.error === 'sign-in-again' && id !== undefined) {
      const token = form.get('token');
      pendingAdds.set(user.id, {
        id,
        token: token === null || token === '' ? undefined : token,
        at: now(),
      });
      askHostAgain(res, user, true);
      return;
    }
    await addWikiPage(res, user, outcome);
  }

  async function removeWiki(user: DoorSessionUser, key: string): Promise<Outcome> {
    if (!isServerAdmin(user)) return { status: 404, body: { error: 'not-found' } };
    const wiki = table.byKey(key);
    if (wiki === undefined || hosts.of(wiki) !== primary) {
      return { status: 404, body: { error: 'not-found' } };
    }
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
    forgejoTokens?.forget(key);
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
    user: DoorSessionUser,
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
    const outcome = await removeWiki(user, form.get('key') ?? '');
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
    if (path !== ADD_WIKI_PAGE && path !== ADD_WIKI_TOKEN_FORM && path !== REMOVE_WIKI_FORM) {
      return false;
    }
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
    const handler =
      path === ADD_WIKI_PAGE ? addWikiForm : path === REMOVE_WIKI_FORM ? removeForm : tokenForm;
    handler(req, res, user).catch(fail);
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
          mcp: new URL('/mcp', settings.externalUrl).toString(),
          message:
            'AI assistants connect to the one /mcp address of this server and name the wiki in each call.',
        });
        return;
      }
      const match = lookup(address.owner, address.name);
      if (user === undefined) {
        needSignIn(req, res, `${rawPath}${search}`);
        return;
      }
      if (match === undefined) {
        notAWiki(req, res);
        return;
      }
      const view = viewFor(match.wiki.key);
      decide(user, match.wiki)
        .then((decision) => {
          if (decision.open && (!match.current || address.rest === '')) {
            res.writeHead(match.current ? 302 : 301, {
              Location: `${wikiPrefix(match.wiki)}${address.rest === '' ? '/' : address.rest}${address.search}`,
              'Cache-Control': 'no-store',
            });
            res.end();
            return undefined;
          }
          return toWiki(
            req,
            res,
            user,
            match.wiki,
            `${address.rest}${address.search}`,
            view,
            decision,
          );
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
        if (user === undefined) {
          needSignIn(req, res, `${rawPath}${search}`);
          return;
        }
        decide(user, fallback)
          .then((decision) => {
            if (decision.open) redirect(res, `${wikiPrefix(fallback)}${rawPath}${search}`);
            else notAWiki(req, res);
          })
          .catch(fail);
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
    const cookieView = readCookie(cookies, viewCookieName(wiki.key));
    const viewSlug = isSlug(cookieView) ? cookieView : undefined;
    void (async () => {
      const decision = await decide(user, wiki);
      if (!decision.open) {
        refuseUpgrade(socket, '404 Not Found');
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
            : await decide(connection.person, wiki);
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
    sessionUser,
    setReady: (value) => {
      ready = value;
    },
  };
}
