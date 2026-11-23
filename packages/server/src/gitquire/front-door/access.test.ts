import { describe, expect, it, vi } from 'vitest';
import type { BotAccess, RepoAccess } from '../host/types.ts';
import { ACCESS_TTL_MS, createWikiAccess } from './access.ts';
import type { WikiRecord } from './wiki-table.ts';

function wiki(name: string, id: number, state: WikiRecord['state'] = 'on'): WikiRecord {
  return {
    host: 'github',
    id,
    owner: 'team',
    ownerId: 7,
    name,
    key: `github-${id}`,
    state,
    formerNames: [],
    addedBy: 'alice',
    addedAt: '',
  };
}

const alice = { id: 1, login: 'alice' };

function setup(levels: Record<string, RepoAccess>, bot: () => BotAccess = () => 'write') {
  let time = 1_000_000;
  const refused = vi.fn();
  const accessCall = vi.fn(
    async (_token: string, repo: { name: string }) => levels[repo.name] ?? 'none',
  );
  const botCall = vi.fn(async () => bot());
  const access = createWikiAccess({
    host: { access: accessCall, accessByBot: botCall },
    runnable: () => true,
    refused,
    now: () => time,
  });
  return {
    access,
    accessCall,
    botCall,
    refused,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('front door access check', () => {
  it('asks the host with the person token for every wiki at sign-in, then answers from the cache', async () => {
    const a = wiki('a', 1);
    const b = wiki('b', 2);
    const off = wiki('c', 3, 'disconnected');
    const { access, accessCall, botCall } = setup({ a: 'admin', b: 'none' });
    await access.signIn(alice, 'person-token', [a, b, off]);
    expect(accessCall).toHaveBeenCalledTimes(3);
    expect(await access.decide(alice, a)).toEqual({ open: true, admin: true });
    expect(await access.decide(alice, b)).toEqual({ open: false, why: 'no-access' });
    expect(await access.decide(alice, off)).toEqual({ open: false, why: 'disconnected' });
    expect(botCall).not.toHaveBeenCalled();
  });

  it('re-checks with GitQuire own token once the answer is older than five minutes', async () => {
    const a = wiki('a', 1);
    let answer: BotAccess = 'none';
    const { access, botCall, advance } = setup({ a: 'write' }, () => answer);
    await access.signIn(alice, 't', [a]);
    advance(ACCESS_TTL_MS + 1);
    expect(await access.decide(alice, a)).toEqual({ open: false, why: 'no-access' });
    expect(botCall).toHaveBeenCalledWith('alice', a);
    answer = 'admin';
    advance(ACCESS_TTL_MS + 1);
    expect(await access.decide(alice, a)).toEqual({ open: true, admin: true });
  });

  it('keeps people inside while the host is unreachable and lets nobody new in (R14)', async () => {
    const a = wiki('a', 1);
    const b = wiki('b', 2);
    const { access, advance } = setup({ a: 'write' }, () => 'unreachable');
    await access.signIn(alice, 't', [a]);
    advance(ACCESS_TTL_MS + 1);
    expect(await access.decide(alice, a)).toEqual({ open: true, admin: false });
    expect(await access.decide(alice, b)).toEqual({ open: false, why: 'unreachable' });
    expect(await access.decide({ id: 2, login: 'bob' }, a)).toEqual({
      open: false,
      why: 'unreachable',
    });
  });

  it('disconnects the wiki when GitQuire own token is refused (R15)', async () => {
    const a = wiki('a', 1);
    const { access, refused, advance } = setup({ a: 'admin' }, () => 'refused:not-admin');
    await access.signIn(alice, 't', [a]);
    advance(ACCESS_TTL_MS + 1);
    expect(await access.decide(alice, a)).toEqual({ open: false, why: 'disconnected' });
    expect(refused).toHaveBeenCalledWith(a, 'not-admin');
  });

  it('lists the wikis a person may open, and disconnected ones only to their admins', async () => {
    const a = wiki('a', 1);
    const b = wiki('b', 2);
    const c = wiki('c', 3);
    const { access } = setup({ a: 'write', b: 'admin', c: 'none' });
    await access.signIn(alice, 't', [a, b, c]);
    b.state = 'disconnected';
    const listed = await access.wikisFor(alice, [a, b, c]);
    expect(listed.map(({ wiki: w, admin }) => [w.name, admin])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('a failed host call at sign-in leaves the wiki to the re-check instead of opening it', async () => {
    const a = wiki('a', 1);
    let time = 0;
    const access = createWikiAccess({
      host: {
        access: async () => {
          throw new Error('offline');
        },
        accessByBot: async () => 'none',
      },
      runnable: () => true,
      refused: () => {},
      now: () => time++,
    });
    await access.signIn(alice, 't', [a]);
    expect(await access.decide(alice, a)).toEqual({ open: false, why: 'no-access' });
  });

  it('treats a wiki whose owner is no longer allowed as disconnected (R18)', async () => {
    const a = wiki('a', 1);
    const access = createWikiAccess({
      host: { access: async () => 'admin', accessByBot: async () => 'admin' },
      runnable: () => false,
      refused: () => {},
    });
    expect(await access.decide(alice, a)).toEqual({ open: false, why: 'disconnected' });
  });

  it('after a restart, shows a disconnected wiki to its admins from the sign-in answer, and to server administrators (R11)', async () => {
    const off = wiki('a', 1, 'disconnected');
    const notAllowed = wiki('b', 2);
    const access = createWikiAccess({
      host: {
        access: async () => 'admin',
        accessByBot: async () => 'admin',
      },
      runnable: (w) => w.name !== 'b',
      refused: () => {},
    });
    await access.signIn(alice, 't', [off, notAllowed]);
    expect(access.wasAdmin(alice, off)).toBe(true);
    expect((await access.wikisFor(alice, [off, notAllowed])).map(({ wiki: w }) => w.name)).toEqual([
      'a',
      'b',
    ]);
    const bob = { id: 2, login: 'bob' };
    expect(await access.wikisFor(bob, [off])).toEqual([]);
    expect(await access.wikisFor(bob, [off], { serverAdmin: true })).toEqual([
      { wiki: off, admin: true },
    ]);
    expect(await access.decide(alice, off)).toEqual({ open: false, why: 'disconnected' });
  });

  it('reports a changed answer so the front door can look the repository up again by id', async () => {
    const a = wiki('a', 1);
    const changed: string[] = [];
    let time = 0;
    let level: BotAccess = 'write';
    const access = createWikiAccess({
      host: { access: async () => 'write', accessByBot: async () => level },
      runnable: () => true,
      refused: () => {},
      changed: (w) => changed.push(w.key),
      now: () => time,
    });
    await access.signIn(alice, 't', [a]);
    time += ACCESS_TTL_MS + 1;
    await access.decide(alice, a);
    expect(changed).toEqual([]);
    level = 'none';
    time += ACCESS_TTL_MS + 1;
    await access.decide(alice, a);
    expect(changed).toEqual(['github-1']);
  });

  it('checks access at sign-in by the wiki record, so the host can go by repository id', async () => {
    const { access, accessCall } = setup({ a: 'write' });
    await access.signIn(alice, 't', [wiki('a', 11)]);
    expect(accessCall).toHaveBeenCalledWith('t', expect.objectContaining({ id: 11, name: 'a' }));
  });
});
