import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailConfig, MailMessage } from '../mail.ts';
import type { Mention } from '../mentions.ts';
import { updateMailRecord } from './mail.ts';
import {
  createPeopleMailer,
  type MailWiki,
  mailedIds,
  markMailed,
  openWithin,
  type PeopleMailLimits,
  type WikiOpen,
} from './mailer.ts';
import { createPeopleStore, type PeopleStore } from './store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const config: MailConfig = {
  host: 'smtp.example.org',
  port: 587,
  implicitTls: false,
  startTls: true,
  user: undefined,
  password: undefined,
  from: 'wiki@example.org',
  externalUrl: undefined,
  allowedDomains: undefined,
};

const T0 = Date.parse('2026-11-25T10:00:00Z');

function mention(id: string, login: string, at: number, by = 'carl'): Mention {
  return {
    id,
    path: 'plan.md',
    docName: 'plan',
    threadId: 't',
    commentId: id,
    author: { id: `x-${by}`, login: by, name: by },
    at: new Date(at).toISOString(),
    body: `@${login} please look`,
    quote: 'the budget',
    resolved: false,
    logins: [login],
  };
}

interface FakeWiki {
  key: string;
  idPrefix: string;
  list: Mention[];
  read: Set<string>;
  open: WikiOpen;
}

function wikiOf(fake: FakeWiki): MailWiki {
  return {
    key: fake.key,
    idPrefix: fake.idPrefix,
    name: `team/${fake.key}`,
    url: `https://wiki.example.org/w/${fake.key}`,
    mentions: () => fake.list,
    readIds: () => fake.read,
    canOpen: async () => fake.open,
  };
}

function setup(fakes: FakeWiki[], limits: Partial<PeopleMailLimits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gq-mailer-'));
  dirs.push(dir);
  const store = createPeopleStore(join(dir, 'people'));
  const sent: MailMessage[] = [];
  let at = T0;
  const make = () =>
    createPeopleMailer({
      store,
      config,
      send: async (_config, message) => {
        sent.push(message);
      },
      wikis: () => fakes.map(wikiOf),
      log: { warn: () => {} },
      now: () => at,
      limits,
    });
  return {
    store,
    sent,
    make,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function switchOn(store: PeopleStore, person: string, login: string, address: string, since = T0) {
  updateMailRecord(store, person, () => ({
    login,
    use: 'other',
    other: { address, confirmedAt: new Date(since).toISOString() },
    since: new Date(since).toISOString(),
    lastSeen: new Date(since).toISOString(),
  }));
  for (const key of KNOWN_AT_SWITCH_ON) markMailed(store, person, key, []);
}

const KNOWN_AT_SWITCH_ON = ['a', 'b', 'f', 'g', 'g1', 'g2', 'g3'];

describe('the one mailer in the front door', () => {
  it('mails mentions from all wikis of the account to the one address, naming each wiki', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [mention('m1', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const b = {
      key: 'b',
      idPrefix: 'github-',
      list: [mention('m2', 'anna', T0 + 2000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent, make } = setup([a, b]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    expect(await make().round()).toBe(2);
    expect(sent.map((m) => m.to)).toEqual(['anna@example.org', 'anna@example.org']);
    expect(sent[0]?.subject).toContain('(team/a)');
    expect(sent[1]?.text).toContain('https://wiki.example.org/w/b/#/plan');
    expect(await make().round()).toBe(0);
  });

  it('mails nothing from a wiki the person can no longer open (P3, P9)', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [mention('m1', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'closed' as WikiOpen,
    };
    const { store, sent, make } = setup([a]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    expect(await make().round()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('when the host cannot be asked, mails and marks nothing and tries again later (P3)', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [mention('m1', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'unknown' as WikiOpen,
    };
    const { store, sent, make } = setup([a]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    const mailer = make();
    expect(await mailer.round()).toBe(0);
    expect(mailedIds(store, 'github-5', 'a').size).toBe(0);
    a.open = 'open';
    expect(await mailer.round()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('does not let one host that is down hold up the other host’s mail (P3)', async () => {
    const down = {
      key: 'g',
      idPrefix: 'github-',
      list: [mention('m1', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'unknown' as WikiOpen,
    };
    const up = {
      key: 'f',
      idPrefix: 'forgejo-',
      list: [mention('m2', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent, make } = setup([down, up]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    switchOn(store, 'forgejo-5', 'anna', 'anna@example.org');
    expect(await make().round()).toBe(1);
    expect(sent).toHaveLength(1);
    const late = await openWithin(new Promise(() => {}), 20);
    expect(late).toBe('unknown');
    expect(await openWithin(Promise.resolve({ open: false, why: 'unreachable' }), 20)).toBe(
      'unknown',
    );
    expect(await openWithin(Promise.resolve({ open: false, why: 'no-access' }), 20)).toBe('closed');
  });

  it('never matches two accounts, also with the same login and address (P5)', async () => {
    const forgejo = {
      key: 'f',
      idPrefix: 'forgejo-',
      list: [mention('m1', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent, make } = setup([forgejo]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    expect(await make().round()).toBe(0);
    switchOn(store, 'forgejo-5', 'anna', 'anna@example.org');
    expect(await make().round()).toBe(1);
    expect(mailedIds(store, 'github-5', 'f').size).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('mails nothing that existed before mail was switched on, also when edited later (P4)', async () => {
    const old = mention('old', 'anna', T0 + 1000);
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [old],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent, make } = setup([a]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    const mailer = make();
    mailer.markExisting('github-5', 'anna');
    a.list = [{ ...old, at: new Date(T0 + 60_000).toISOString(), body: '@anna edited' }];
    expect(await mailer.round()).toBe(0);
    a.list = [...a.list, mention('new', 'anna', T0 + 2000)];
    expect(await mailer.round()).toBe(1);
    expect(sent.map((m) => m.text).join('\n')).not.toContain('edited');
  });

  it('pays the wait for a host that does not answer once per round, and the other host goes on (P3)', async () => {
    let asked = 0;
    const hanging: MailWiki[] = ['g1', 'g2', 'g3'].map((key) => ({
      key,
      idPrefix: 'github-',
      name: key,
      url: undefined,
      mentions: () => [mention(`m-${key}`, 'anna', T0 + 1000)],
      readIds: () => new Set(),
      canOpen: () => {
        asked += 1;
        return openWithin(new Promise(() => {}), 30);
      },
    }));
    const up = {
      key: 'f',
      idPrefix: 'forgejo-',
      list: [mention('mf', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent } = setup([up]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    switchOn(store, 'github-6', 'anna', 'anna2@example.org');
    switchOn(store, 'forgejo-5', 'anna', 'anna@example.org');
    const mailer = createPeopleMailer({
      store,
      config,
      send: async (_c, message) => {
        sent.push(message);
      },
      wikis: () => [...hanging, wikiOf(up)],
      log: { warn: () => {} },
      now: () => T0,
    });
    const started = Date.now();
    expect(await mailer.round()).toBe(1);
    expect(asked).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(mailedIds(store, 'github-5', 'g1').size).toBe(0);
  });

  it('does not mail the backlog of a wiki added after the switch-on, only what comes later', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [] as Mention[],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const added = {
      key: 'added',
      idPrefix: 'github-',
      list: [mention('old', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const fakes = [a];
    const { store, sent, make } = setup(fakes);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    const mailer = make();
    expect(await mailer.round()).toBe(0);
    fakes.push(added);
    expect(await mailer.round()).toBe(0);
    expect(sent).toEqual([]);
    added.list.push(mention('new', 'anna', T0 + 5000));
    expect(await mailer.round()).toBe(1);
    expect(sent[0]?.text).toContain('team/added');
  });

  it('mails nothing twice when its record of what was mailed cannot be read', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [mention('m1', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent, make } = setup([a]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    expect(await make().round()).toBe(1);
    writeFileSync(join(store.root, 'github-5', 'mailed.json'), '{"a": ["m1"');
    const reopened = createPeopleStore(store.root);
    const mailer = createPeopleMailer({
      store: reopened,
      config,
      send: async (_c, message) => {
        sent.push(message);
      },
      wikis: () => [wikiOf(a)],
      log: { warn: () => {} },
      now: () => T0,
    });
    expect(await mailer.round()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(mailedIds(reopened, 'github-5', 'a').has('m1')).toBe(true);
  });

  it('does not send a mention that was marked mailed while the round waited', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [mention('m1', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent, make } = setup([a]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    const mailer = make();
    const wiki = wikiOf(a);
    const slow: MailWiki = {
      ...wiki,
      canOpen: async () => {
        updateMailRecord(store, 'github-5', (record) => ({
          ...record,
          since: new Date(T0 + 5000).toISOString(),
        }));
        mailer.markExisting('github-5', 'anna');
        return 'open';
      },
    };
    const racing = createPeopleMailer({
      store,
      config,
      send: async (_c, message) => {
        sent.push(message);
      },
      wikis: () => [slow],
      log: { warn: () => {} },
      now: () => T0 + 6000,
    });
    expect(await racing.round()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('keeps "mailed" over a restart and holds the hourly limit for the whole server (P10)', async () => {
    const list = ['anna', 'bert', 'cleo'].map((login, n) => mention(`m${n}`, login, T0 + 1000));
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list,
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent, make } = setup([a], { perHour: 2 });
    switchOn(store, 'github-1', 'anna', 'anna@example.org');
    switchOn(store, 'github-2', 'bert', 'bert@example.org');
    switchOn(store, 'github-3', 'cleo', 'cleo@example.org');
    const first = make();
    expect(await first.round()).toBe(2);
    expect(await first.round()).toBe(0);
    const restarted = make();
    expect(await restarted.round()).toBe(1);
    expect(await restarted.round()).toBe(0);
    expect(new Set(sent.map((m) => m.to)).size).toBe(3);
  });

  it('holds the daily limit per person over all wikis and rounds, and lets others through (P10)', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [
        ...['a1', 'a2', 'a3'].map((id) => mention(id, 'anna', T0 + 1000)),
        mention('b1', 'bert', T0 + 1000),
      ],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const b = {
      key: 'b',
      idPrefix: 'github-',
      list: ['b2', 'b3'].map((id) => mention(id, 'anna', T0 + 1000)),
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, sent, make, advance } = setup([a, b], {
      perPersonPerDay: 4,
      perPersonPerRound: 2,
    });
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    switchOn(store, 'github-6', 'bert', 'bert@example.org');
    const mailer = make();
    expect(await mailer.round()).toBe(3);
    expect(await mailer.round()).toBe(2);
    expect(await mailer.round()).toBe(0);
    expect(sent.filter((m) => m.to === 'anna@example.org')).toHaveLength(4);
    expect(sent.filter((m) => m.to === 'bert@example.org')).toHaveLength(1);
    advance(24 * 60 * 60 * 1000);
    expect(await mailer.round()).toBe(1);
  });

  it('skips read mentions, the author’s own and mentions of others', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [
        mention('read', 'anna', T0 + 1),
        mention('self', 'anna', T0 + 1, 'anna'),
        mention('bert', 'bert', T0 + 1),
      ],
      read: new Set(['read']),
      open: 'open' as WikiOpen,
    };
    const { store, make } = setup([a]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    expect(await make().round()).toBe(0);
  });

  it('stops when mail is switched off or the person has been away for 30 days', async () => {
    const a = {
      key: 'a',
      idPrefix: 'github-',
      list: [mention('m1', 'anna', T0 + 1000)],
      read: new Set<string>(),
      open: 'open' as WikiOpen,
    };
    const { store, make, advance } = setup([a]);
    switchOn(store, 'github-5', 'anna', 'anna@example.org');
    advance(31 * 24 * 60 * 60 * 1000);
    expect(await make().round()).toBe(0);
    updateMailRecord(store, 'github-5', ({ use: _use, ...rest }) => ({
      ...rest,
      lastSeen: new Date(T0 + 31 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    expect(await make().round()).toBe(0);
  });
});
