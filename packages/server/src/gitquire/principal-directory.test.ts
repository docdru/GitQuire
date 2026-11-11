import type { IncomingMessage } from 'node:http';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveWriterFromOrigin } from '../persistence.ts';
import {
  attributeEdit,
  commitAuthorEnv,
  type GitQuirePrincipal,
  principalIdForGitHubUser,
  rememberPrincipal,
  resetPrincipalDirectory,
  restoreCommitAuthors,
  sanitizeDisplayName,
  sessionPrincipal,
  sessionPrincipalForAuthPayload,
  setSessionPrincipalResolver,
  takeCommitAuthors,
  withCoAuthorTrailers,
} from './principal-directory.ts';

const alice: GitQuirePrincipal = {
  id: principalIdForGitHubUser(42),
  login: 'alice',
  name: 'Alice A',
  email: '42+alice@users.noreply.github.com',
};
const bob: GitQuirePrincipal = {
  id: principalIdForGitHubUser(7),
  login: 'bob',
  name: 'Bob B',
  email: '7+bob@users.noreply.github.com',
};

beforeEach(() => {
  resetPrincipalDirectory();
});

describe('session principals', () => {
  it('resolves the signed-in user from the request and remembers them', () => {
    setSessionPrincipalResolver((req) => (req.headers.cookie === 'alice' ? alice : undefined));
    expect(sessionPrincipal({ headers: {} } as IncomingMessage)).toBeUndefined();
    expect(sessionPrincipal({ headers: { cookie: 'alice' } } as IncomingMessage)).toEqual(alice);
    expect(attributeEdit(alice.id)).toEqual({
      id: 'github-42',
      name: 'Alice A',
      email: '42+alice@users.noreply.github.com',
    });
  });

  it('reads the session cookie from a live-editing auth payload', () => {
    setSessionPrincipalResolver((req) =>
      req.headers.cookie === 'gq_session=a' ? alice : undefined,
    );
    const fetchStyle = { request: { headers: new Headers({ cookie: 'gq_session=a' }) } };
    const nodeStyle = { request: { headers: { cookie: 'gq_session=a' } } };
    const headersBag = { requestHeaders: new Headers({ cookie: 'gq_session=a' }) };
    expect(sessionPrincipalForAuthPayload(fetchStyle)).toEqual(alice);
    expect(sessionPrincipalForAuthPayload(nodeStyle)).toEqual(alice);
    expect(sessionPrincipalForAuthPayload(headersBag)).toEqual(alice);
    expect(sessionPrincipalForAuthPayload({ request: { headers: new Headers() } })).toBeUndefined();
    expect(sessionPrincipalForAuthPayload(undefined)).toBeUndefined();
  });

  it('stays inert without a resolver', () => {
    expect(sessionPrincipal({ headers: {} } as IncomingMessage)).toBeUndefined();
    expect(attributeEdit('github-42')).toBeUndefined();
  });
});

describe('commit authors', () => {
  it('ranks authors by edits, then by who edited first, and clears', () => {
    rememberPrincipal(alice);
    rememberPrincipal(bob);
    attributeEdit(alice.id);
    attributeEdit(bob.id);
    attributeEdit(bob.id);
    expect(takeCommitAuthors()).toEqual([bob, alice]);
    expect(takeCommitAuthors()).toEqual([]);

    attributeEdit(alice.id);
    attributeEdit(bob.id);
    expect(takeCommitAuthors()).toEqual([alice, bob]);
  });

  it('puts authors back when a commit does not happen', () => {
    rememberPrincipal(alice);
    attributeEdit(alice.id);
    const authors = takeCommitAuthors();
    restoreCommitAuthors(authors);
    expect(takeCommitAuthors()).toEqual([alice]);
  });

  it('authors the commit as the main editor and credits the others', () => {
    expect(commitAuthorEnv([])).toBeUndefined();
    expect(commitAuthorEnv([bob, alice])).toEqual({
      GIT_AUTHOR_NAME: 'Bob B',
      GIT_AUTHOR_EMAIL: '7+bob@users.noreply.github.com',
    });
    expect(withCoAuthorTrailers('Auto-save: Updated plan.md', [bob])).toBe(
      'Auto-save: Updated plan.md',
    );
    expect(withCoAuthorTrailers('Auto-save: Updated plan.md', [bob, alice])).toBe(
      'Auto-save: Updated plan.md\n\nCo-authored-by: Alice A <42+alice@users.noreply.github.com>',
    );
  });
});

describe('display name hardening', () => {
  it('strips line breaks, control characters and angle brackets', () => {
    expect(sanitizeDisplayName('Eve\nCo-authored-by: Mallory <m@x>', 'eve')).toBe(
      'Eve Co-authored-by: Mallory m@x',
    );
    expect(sanitizeDisplayName('  Ada\t Lovelace\r ', 'ada')).toBe('Ada Lovelace');
    expect(sanitizeDisplayName('\n\u0007', 'ada')).toBe('ada');
  });

  it('keeps injected names out of commit trailers and author env', () => {
    const eve: GitQuirePrincipal = {
      id: principalIdForGitHubUser(9),
      login: 'eve',
      name: 'Eve\nSigned-off-by: Admin <admin@example.com>',
      email: '9+eve@users.noreply.github.com',
    };
    const message = withCoAuthorTrailers('Auto-save: x', [alice, eve]);
    expect(message.split('\n')).toEqual([
      'Auto-save: x',
      '',
      'Co-authored-by: Eve Signed-off-by: Admin admin@example.com <9+eve@users.noreply.github.com>',
    ]);
    expect(commitAuthorEnv([eve])?.GIT_AUTHOR_NAME).toBe(
      'Eve Signed-off-by: Admin admin@example.com',
    );
  });
});

describe('resolveWriterFromOrigin with GitQuire sessions', () => {
  const connectionOrigin = (principalId: string) => ({
    source: 'connection',
    connection: { context: { principalId } },
  });

  it('attributes a signed-in connection edit to the GitHub user', () => {
    rememberPrincipal(alice);
    expect(resolveWriterFromOrigin(connectionOrigin(alice.id))).toEqual({
      id: 'github-42',
      name: 'Alice A',
      email: '42+alice@users.noreply.github.com',
    });
    expect(takeCommitAuthors()).toEqual([alice]);
  });

  it('keeps upstream behaviour for unknown principals', () => {
    expect(resolveWriterFromOrigin(connectionOrigin('local-abc'))).toEqual({
      id: 'local-abc',
      name: 'Local User',
      email: 'local-abc@openknowledge.local',
    });
  });
});
