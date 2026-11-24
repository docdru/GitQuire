import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { SessionUser } from './access-gate.ts';
import { INTERNAL_REQUEST_HEADER, internalRequestHeaders } from './internal-request.ts';
import {
  behindFrontDoorFromEnv,
  bindRequestPrefix,
  createRequestPerson,
  encodeAgentFeatures,
  encodeProxiedUser,
  FORWARDED_AGENTS_HEADER,
  FORWARDED_AGENTS_HOST_HEADER,
  FORWARDED_PREFIX_HEADER,
  FORWARDED_VIEW_HEADER,
  forwardedAgentFeatures,
  forwardedAgentPaths,
  forwardedPrefix,
  forwardedView,
  PROXIED_PRINCIPAL_HEADER,
  requestPrefix,
} from './request-person.ts';

const ALICE: SessionUser = { id: 42, login: 'alice', name: 'Alice', avatarUrl: '' };
const BOSS: SessionUser = { ...ALICE, id: 7, login: 'boss', repoAdmin: true };

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function forwarded(user: SessionUser, extra: Record<string, string> = {}): IncomingMessage {
  return req({
    ...internalRequestHeaders(),
    [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(user),
    ...extra,
  });
}

describe('the front-door switch', () => {
  it('is off unless set', () => {
    expect(behindFrontDoorFromEnv({})).toBe(false);
    expect(behindFrontDoorFromEnv({ GITQUIRE_BEHIND_FRONT_DOOR: '0' })).toBe(false);
    expect(behindFrontDoorFromEnv({ GITQUIRE_BEHIND_FRONT_DOOR: ' on ' })).toBe(true);
    expect(behindFrontDoorFromEnv({ GITQUIRE_BEHIND_FRONT_DOOR: '1' })).toBe(true);
  });
});

describe('who is this request', () => {
  it('behind the front door, is the forwarded person and their admin flag for this wiki', () => {
    const person = createRequestPerson({ behindFrontDoor: true });
    expect(person.sessionUser(forwarded(ALICE))).toEqual(ALICE);
    expect(person.isAdminRequest(forwarded(ALICE))).toBe(false);
    expect(person.isAdminRequest(forwarded(BOSS))).toBe(true);
    expect(person.agentOwner(forwarded(ALICE))).toEqual(ALICE);
  });

  it('behind the front door, trusts nobody without the internal secret, cookie or not', () => {
    const person = createRequestPerson({
      behindFrontDoor: true,
      cookieUser: () => BOSS,
      isAdmin: () => true,
    });
    const forged = req({
      [INTERNAL_REQUEST_HEADER]: 'guess',
      [PROXIED_PRINCIPAL_HEADER]: encodeProxiedUser(BOSS),
      cookie: 'gq_session=anything',
    });
    expect(person.sessionUser(forged)).toBeUndefined();
    expect(person.isAdminRequest(forged)).toBe(false);
    expect(person.agentOwner(forged)).toBeUndefined();
  });

  it('otherwise, is the session cookie for pages and an agent token or the forwarded person for assistants', () => {
    const person = createRequestPerson({
      behindFrontDoor: false,
      cookieUser: (r) => (r.headers.cookie === 'alice' ? ALICE : undefined),
      agentTokenOwner: (r) => (r.headers.authorization === 'Bearer t' ? BOSS : undefined),
      isAdmin: (user) => user.login === 'alice',
    });
    expect(person.sessionUser(req({ cookie: 'alice' }))).toEqual(ALICE);
    expect(person.sessionUser(forwarded(BOSS))).toBeUndefined();
    expect(person.isAdminRequest(req({ cookie: 'alice' }))).toBe(true);
    expect(person.isAdminRequest(forwarded(BOSS))).toBe(false);
    expect(person.agentOwner(req({ authorization: 'Bearer t' }))).toEqual(BOSS);
    expect(person.agentOwner(forwarded(ALICE))).toEqual(ALICE);
  });
});

describe('forwarded prefix and draft view', () => {
  it('takes the prefix only behind the front door and only with the secret', () => {
    const withPrefix = { ...internalRequestHeaders(), [FORWARDED_PREFIX_HEADER]: '/w/team/wiki' };
    expect(forwardedPrefix(req(withPrefix), true)).toBe('/w/team/wiki');
    expect(forwardedPrefix(req(withPrefix), false)).toBe('');
    expect(forwardedPrefix(req({ [FORWARDED_PREFIX_HEADER]: '/w/team/wiki' }), true)).toBe('');
  });

  it('takes a repo whose name starts with a dot, as the app does', () => {
    const headers = { ...internalRequestHeaders(), [FORWARDED_PREFIX_HEADER]: '/w/team/.github' };
    expect(forwardedPrefix(req(headers), true)).toBe('/w/team/.github');
  });

  it('refuses a prefix that is not a plain path', () => {
    for (const bad of ['w/team', '/w/team/', '//evil.example', '/w/../x', '/w/a b', '/w/"x']) {
      const headers = { ...internalRequestHeaders(), [FORWARDED_PREFIX_HEADER]: bad };
      expect(forwardedPrefix(req(headers), true)).toBe('');
    }
  });

  it('takes the open draft only behind the front door and only with the secret', () => {
    const withView = { ...internalRequestHeaders(), [FORWARDED_VIEW_HEADER]: 'plan' };
    expect(forwardedView(req(withView), true)).toBe('plan');
    expect(forwardedView(req(withView), false)).toBeUndefined();
    expect(forwardedView(req({ [FORWARDED_VIEW_HEADER]: 'plan' }), true)).toBeUndefined();
  });

  it('remembers the prefix the gate bound to a request', () => {
    const one = req({});
    const two = req({});
    bindRequestPrefix(one, '/w/team/wiki');
    bindRequestPrefix(two, '');
    expect(requestPrefix(one)).toBe('/w/team/wiki');
    expect(requestPrefix(two)).toBe('');
  });
});

describe('the agent access the front door passes on', () => {
  const none = { agentToken: false, connector: false, canUseTokens: false, canConnect: false };
  const all = { agentToken: true, connector: true, canUseTokens: true, canConnect: true };

  it('round-trips with the internal secret behind the front door', () => {
    const header = encodeAgentFeatures({ ...none, canUseTokens: true, agentToken: true });
    expect(header).toBe('token,tokens');
    expect(
      forwardedAgentFeatures(forwarded(ALICE, { [FORWARDED_AGENTS_HEADER]: header }), true),
    ).toEqual({ ...none, canUseTokens: true, agentToken: true });
    expect(
      forwardedAgentFeatures(
        forwarded(ALICE, { [FORWARDED_AGENTS_HEADER]: encodeAgentFeatures(all) }),
        true,
      ),
    ).toEqual(all);
  });

  it('is ignored without the secret or outside the front door', () => {
    const header = encodeAgentFeatures(all);
    expect(forwardedAgentFeatures(req({ [FORWARDED_AGENTS_HEADER]: header }), true)).toEqual(none);
    expect(
      forwardedAgentFeatures(
        req({ [INTERNAL_REQUEST_HEADER]: 'wrong', [FORWARDED_AGENTS_HEADER]: header }),
        true,
      ),
    ).toEqual(none);
    expect(
      forwardedAgentFeatures(forwarded(ALICE, { [FORWARDED_AGENTS_HEADER]: header }), false),
    ).toEqual(none);
  });
});

describe('the agent addresses of a further host', () => {
  it('are passed on only behind the front door with the secret and a host key', () => {
    const host = { [FORWARDED_AGENTS_HOST_HEADER]: 'forgejo' };
    expect(forwardedAgentPaths(forwarded(ALICE, host), true)).toEqual({
      agentsPath: '/auth/forgejo/agents',
      mcpPath: '/mcp/forgejo',
    });
    expect(forwardedAgentPaths(forwarded(ALICE), true)).toBeUndefined();
    expect(forwardedAgentPaths(req(host), true)).toBeUndefined();
    expect(forwardedAgentPaths(forwarded(ALICE, host), false)).toBeUndefined();
    expect(
      forwardedAgentPaths(forwarded(ALICE, { [FORWARDED_AGENTS_HOST_HEADER]: '../x' }), true),
    ).toBeUndefined();
  });
});
