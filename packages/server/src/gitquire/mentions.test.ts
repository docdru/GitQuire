import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommentThread,
  writeCommentThreads,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import { describe, expect, it } from 'vitest';
import {
  confirmationMail,
  displayConfirmationCode,
  hashConfirmationCode,
  newConfirmationCode,
  normalizeConfirmationCode,
  recipientKey,
} from './email-confirmation.ts';
import { type MailConfig, type MailMessage, SmtpError } from './mail.ts';
import { createMentionMailer, mentionMail, pageLink } from './mention-mailer.ts';
import {
  buildInbox,
  createMentionIndex,
  createMentionReadStore,
  docNameForPath,
  mentionStatePath,
  mentionsFor,
  mentionsInMarkdown,
} from './mentions.ts';
import { createGitQuireRoutes } from './routes.ts';

const alice = { id: 1, login: 'Alice' };
const bob = { id: 2, login: 'bob' };

function thread(id: string, comments: CommentThread['comments'], resolved = false): CommentThread {
  return { id, anchor: { exact: 'quarterly numbers' }, resolved, comments };
}

function comment(
  id: string,
  author: { id: number; login: string },
  body: string,
  createdAt: string,
  mentions: string[],
): CommentThread['comments'][number] {
  return {
    id,
    author: { id: `github-${author.id}`, login: author.login, name: author.login },
    createdAt,
    body,
    mentions,
  };
}

function page(threads: CommentThread[]): string {
  return writeCommentThreads('The quarterly numbers look good.\n', threads);
}

function ids(mentions: readonly { id: string }[]): string[] {
  return mentions.map((mention) => mention.id).sort((x, y) => x.localeCompare(y));
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-mentions-'));
  mkdirSync(join(dir, 'notes'), { recursive: true });
  mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  const ask = comment('c1', bob, 'Can you check this, @alice?', '2026-11-10T09:00:00Z', ['alice']);
  const answer = comment('c2', alice, 'Done, @bob.', '2026-11-10T10:00:00Z', ['bob']);
  const shared = comment('c3', bob, '@alice @carol?', '2026-11-11T08:00:00Z', ['alice', 'carol']);
  const own = comment('c4', alice, 'Note to self @alice', '2026-11-11T09:00:00Z', ['alice']);
  const hidden = comment('c9', bob, '@alice', '2026-11-11T08:00:00Z', ['alice']);
  const report = page([thread('t1', [ask, answer])]);
  const plan = page([thread('t2', [shared], true), thread('t3', [own])]);
  writeFileSync(join(dir, 'notes', 'report.md'), report);
  writeFileSync(join(dir, 'plan.md'), plan);
  writeFileSync(join(dir, 'node_modules', 'pkg', 'readme.md'), report);
  writeFileSync(join(dir, '.ok', 'local', 'hidden.md'), page([thread('t9', [hidden])]));
  return dir;
}

describe('mention index', () => {
  it('finds mentions in the comments block of a page', () => {
    const greeting = comment('c1', bob, 'Hi @alice', '2026-11-10T09:00:00Z', ['alice']);
    const [found, ...rest] = mentionsInMarkdown('a.md', page([thread('t1', [greeting])]));
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      id: 't1:c1',
      path: 'a.md',
      docName: 'a',
      quote: 'quarterly numbers',
      body: 'Hi @alice',
      logins: ['alice'],
    });
    expect(mentionsInMarkdown('a.md', 'No comments here.\n')).toEqual([]);
  });

  it('scans the project, skipping hidden and dependency folders', () => {
    const dir = project();
    try {
      const index = createMentionIndex(dir);
      expect(ids(index.all())).toEqual(['t1:c1', 't1:c2', 't2:c3', 't3:c4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks up a page that changed, after reusing a scan for a few seconds', () => {
    const dir = project();
    try {
      let clock = 1000;
      const index = createMentionIndex(dir, () => clock);
      expect(index.all()).toHaveLength(4);
      writeFileSync(join(dir, 'plan.md'), 'Rewritten without any comments at all.\n');
      clock += 1000;
      expect(index.all()).toHaveLength(4);
      clock += 5000;
      expect(ids(index.all())).toEqual(['t1:c1', 't1:c2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('page names', () => {
  it('strips the document extension and rejects other files', () => {
    expect(docNameForPath('notes/report.md')).toBe('notes/report');
    expect(docNameForPath('Guide.MDX')).toBe('Guide');
    expect(docNameForPath('image.png')).toBeUndefined();
  });

  it('lists a copied page once', () => {
    const copy = comment('c1', bob, 'Hi @alice', '2026-11-10T09:00:00Z', ['alice']);
    const text = page([thread('t1', [copy])]);
    const all = [...mentionsInMarkdown('a.md', text), ...mentionsInMarkdown('copy/a.md', text)];
    expect(mentionsFor(alice, all).map((mention) => mention.path)).toEqual(['a.md']);
  });
});

describe('inbox', () => {
  it('lists mentions of the reader, newest first, without their own', () => {
    const dir = project();
    try {
      const all = createMentionIndex(dir).all();
      expect(mentionsFor(alice, all).map((mention) => mention.id)).toEqual(['t2:c3', 't1:c1']);
      expect(mentionsFor(bob, all).map((mention) => mention.id)).toEqual(['t1:c2']);
      const inbox = buildInbox(alice, all, new Set(['t1:c1']));
      expect(inbox.unread).toBe(1);
      const rows = inbox.mentions.map((mention) => [mention.id, mention.read, mention.resolved]);
      expect(rows).toEqual([
        ['t2:c3', false, true],
        ['t1:c1', true, false],
      ]);
      expect(inbox.mentions[0]).not.toHaveProperty('logins');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remembers what was read, per person, also while a page is away', () => {
    const dir = project();
    try {
      const file = mentionStatePath(dir);
      const store = createMentionReadStore(file);
      store.markRead(1, ['t1:c1', 'unknown'], new Set(['t1:c1', 't2:c3']));
      expect([...store.readIds(1)]).toEqual(['t1:c1']);
      expect([...store.readIds(2)]).toEqual([]);
      expect([...createMentionReadStore(file).readIds(1)]).toEqual(['t1:c1']);
      store.markRead(1, ['t2:c3'], new Set(['t2:c3']));
      expect([...store.readIds(1)]).toEqual(['t1:c1', 't2:c3']);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        version: 1,
        users: { '1': { read: ['t1:c1', 't2:c3'] } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts empty when the state file is damaged', () => {
    const dir = project();
    try {
      const file = mentionStatePath(dir);
      mkdirSync(join(dir, '.ok', 'local', 'gitquire'), { recursive: true });
      writeFileSync(file, '{not json');
      expect([...createMentionReadStore(file).readIds(1)]).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function call(
  routes: ReturnType<typeof createGitQuireRoutes>,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number | undefined; body: Record<string, unknown> }> {
  const { promise, resolve } = Promise.withResolvers<{
    status: number | undefined;
    body: Record<string, unknown>;
  }>();
  let status: number | undefined;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code: number) {
      status = code;
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      res.writableEnded = true;
      resolve({ status, body: chunk === undefined ? {} : JSON.parse(chunk) });
      return res;
    },
  };
  const chunks = init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))];
  const req = {
    url,
    method: init.method ?? 'GET',
    headers: { host: 'brain.example.com', origin: 'https://brain.example.com' },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  } as unknown as IncomingMessage;
  expect(routes.handle(req, res as unknown as ServerResponse)).toBe(true);
  return promise;
}

describe('mention routes', () => {
  it('serves the inbox of the signed-in person and marks mentions read', async () => {
    const dir = project();
    try {
      const routes = createGitQuireRoutes({
        projectDir: dir,
        log: silentLog,
        sessionUser: () => ({ ...alice, name: 'Alice', avatarUrl: '' }),
      });
      const first = await call(routes, '/api/gitquire/mentions');
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ enabled: true, login: 'Alice', unread: 2 });
      const one = await call(routes, '/api/gitquire/mentions/read', {
        method: 'POST',
        body: { ids: ['t1:c1', 't1:c2'] },
      });
      expect(one.body).toEqual({ unread: 1 });
      const all = await call(routes, '/api/gitquire/mentions/read', {
        method: 'POST',
        body: { all: true },
      });
      expect(all.body).toEqual({ unread: 0 });
      const bad = await call(routes, '/api/gitquire/mentions/read', {
        method: 'POST',
        body: { ids: 'nope' },
      });
      expect(bad.status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const EMAIL_URL = '/api/gitquire/mentions/email';

  function mailRoutes(dir: string, sent: MailMessage[], failing: { on: boolean }) {
    return createGitQuireRoutes({
      projectDir: dir,
      log: silentLog,
      sessionUser: () => ({ ...alice, name: 'Alice', avatarUrl: '' }),
      env: {
        GITQUIRE_SMTP_URL: 'smtps://mail.example.com',
        GITQUIRE_MAIL_FROM: 'wiki@example.com',
        OK_EXTERNAL_URL: 'https://brain.example.com/',
      },
      sendMail: async (_config, message) => {
        if (failing.on) throw new Error('mail server down');
        sent.push(message);
      },
      mailRoundMs: 3_600_000,
    });
  }

  function codeIn(message: MailMessage | undefined): string {
    const match = /Confirmation code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(message?.text ?? '');
    if (match === null) throw new Error('expected a confirmation code in the mail');
    return match[1] as string;
  }

  function putEmail(routes: ReturnType<typeof createGitQuireRoutes>, body: unknown) {
    return call(routes, EMAIL_URL, { method: 'PUT', body });
  }

  function confirmCode(routes: ReturnType<typeof createGitQuireRoutes>, code: unknown) {
    return call(routes, `${EMAIL_URL}/confirm`, { method: 'POST', body: { code } });
  }

  it('turns email on only after the code from the confirmation mail is entered', async () => {
    const dir = project();
    const sent: MailMessage[] = [];
    const routes = mailRoutes(dir, sent, { on: false });
    try {
      const before = await call(routes, '/api/gitquire/mentions');
      expect(before.body.email).toEqual({ available: true, address: null, pending: null });
      expect((await putEmail(routes, { address: 'not an address' })).status).toBe(400);
      const asked = await putEmail(routes, { address: ' alice@example.com ' });
      const waiting = { available: true, address: null, pending: 'alice@example.com' };
      expect(asked.body).toEqual(waiting);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe('alice@example.com');
      expect(sent[0]?.subject).toBe('Confirm your address for GitQuire mentions');
      expect(sent[0]?.text).toContain('The GitHub user "Alice" asked GitQuire at');
      expect(await routes.mailRound()).toBe(0);

      const wrong = await confirmCode(routes, 'AAAA-AAAA');
      expect([wrong.status, wrong.body.error]).toEqual([400, 'wrong-code']);
      const right = await confirmCode(routes, codeIn(sent[0]).toLowerCase().replace('-', ' '));
      expect(right.body).toEqual({ available: true, address: 'alice@example.com', pending: null });
      expect(await routes.mailRound()).toBe(0);
      expect(sent).toHaveLength(1);
      expect((await confirmCode(routes, codeIn(sent[0]))).status).toBe(409);

      const off = await putEmail(routes, { address: null });
      expect(off.body).toEqual({ available: true, address: null, pending: null });
    } finally {
      routes.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps nothing when the confirmation mail fails, but still counts it', async () => {
    const dir = project();
    const sent: MailMessage[] = [];
    const routes = mailRoutes(dir, sent, { on: true });
    try {
      const failed = await putEmail(routes, { address: 'alice@example.com' });
      expect([failed.status, failed.body.error]).toEqual([502, 'mail-failed']);
      expect((await call(routes, '/api/gitquire/mentions')).body.email).toMatchObject({
        pending: null,
      });
      const tooSoon = await putEmail(routes, { address: 'alice@example.com' });
      expect([tooSoon.status, tooSoon.body.error]).toEqual([429, 'resend-too-soon']);
      expect(sent).toHaveLength(0);
    } finally {
      routes.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows five tries, and turning email off does not reset the wait', async () => {
    const dir = project();
    const sent: MailMessage[] = [];
    const routes = mailRoutes(dir, sent, { on: false });
    try {
      const both = await Promise.all([
        putEmail(routes, { address: 'alice@example.com' }),
        putEmail(routes, { address: 'alice@example.com' }),
      ]);
      expect(both.map((result) => result.status).sort()).toEqual([200, 429]);
      expect(sent).toHaveLength(1);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await confirmCode(routes, 'AAAA-AAAA')).body.error).toBe('wrong-code');
      }
      const locked = await confirmCode(routes, 'AAAA-AAAA');
      expect([locked.status, locked.body.error]).toEqual([429, 'too-many-tries']);
      expect((await confirmCode(routes, codeIn(sent[0]))).status).toBe(409);
      expect((await putEmail(routes, { address: null })).status).toBe(200);
      const afterOff = await putEmail(routes, { address: 'alice@example.com' });
      expect([afterOff.status, afterOff.body.error]).toEqual([429, 'resend-too-soon']);
      expect((await putEmail(routes, { cancel: true })).body).toEqual({
        available: true,
        address: null,
        pending: null,
      });
    } finally {
      routes.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers that mail is not set up when someone tries to subscribe', async () => {
    const routes = createGitQuireRoutes({
      projectDir: '/nonexistent',
      log: silentLog,
      sessionUser: () => ({ ...alice, name: 'Alice', avatarUrl: '' }),
      env: {},
    });
    const result = await call(routes, '/api/gitquire/mentions/email', {
      method: 'PUT',
      body: { address: 'alice@example.com' },
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('mail-not-configured');
  });

  it('reports the inbox as off without sign-in', async () => {
    const routes = createGitQuireRoutes({ projectDir: '/nonexistent', log: silentLog });
    const list = await call(routes, '/api/gitquire/mentions');
    expect(list.body).toEqual({
      enabled: false,
      login: null,
      unread: 0,
      mentions: [],
      email: { available: false, address: null, pending: null },
    });
    const read = await call(routes, '/api/gitquire/mentions/read', {
      method: 'POST',
      body: { all: true },
    });
    expect(read.status).toBe(401);
  });
});

describe('confirmation store', () => {
  it('keeps a confirmed address while a new one waits, and expires old codes', () => {
    const dir = project();
    try {
      const rules = { validMs: 1000, maxAttempts: 2 };
      const store = createMentionReadStore(mentionStatePath(dir), rules);
      const start = new Date('2026-11-12T10:00:00Z');
      store.reserveConfirmation(alice, 'to-old', start);
      store.startConfirmation(alice, 'old@example.com', 'hash-1', start);
      expect(store.confirm(alice, 'hash-1', ['t1:c1'], start)).toBe('confirmed');
      expect(store.emailOf(alice.id)).toBe('old@example.com');
      expect([...store.mailedIds(alice.id)]).toEqual(['t1:c1']);
      store.reserveConfirmation(alice, 'to-new', start);
      store.startConfirmation(alice, 'new@example.com', 'hash-2', start);
      expect(store.emailOf(alice.id)).toBe('old@example.com');
      expect(store.pendingOf(alice.id, start)?.email).toBe('new@example.com');
      const late = new Date(start.getTime() + 2000);
      expect(store.pendingOf(alice.id, late)).toBeUndefined();
      expect(store.recipientConfirmationsSince('to-new', start)).toBe(1);
      expect(store.confirm(alice, 'hash-2', [], late)).toBe('expired');
      expect(store.pendingOf(alice.id, start)).toBeUndefined();
      expect(store.emailOf(alice.id)).toBe('old@example.com');
      expect(store.confirmationsSince(alice.id, new Date(start.getTime() - 1))).toBe(2);
      store.setEmail(alice, undefined, [], late);
      expect(store.emailOf(alice.id)).toBeUndefined();
      expect(store.lastConfirmationAt(alice.id)).toBe(start.toISOString());
      expect(store.confirmationsSince(undefined, late)).toBe(0);
      expect(store.confirm(alice, 'hash-2', [], late)).toBe('none');
      const reloaded = createMentionReadStore(mentionStatePath(dir));
      expect(reloaded.emailOf(alice.id)).toBeUndefined();
      expect(reloaded.lastConfirmationAt(alice.id)).toBe(start.toISOString());
      expect(reloaded.recipientConfirmationsSince('to-new', start)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('confirmation mail', () => {
  it('has a readable code that survives spaces, dashes and lower case', () => {
    const code = newConfirmationCode();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    const shown = displayConfirmationCode(code);
    expect(shown).toMatch(/^.{4}-.{4}$/);
    expect(normalizeConfirmationCode(` ${shown.toLowerCase()} `)).toBe(code);
    expect(hashConfirmationCode('k', 1, shown)).toBe(hashConfirmationCode('k', 1, code));
    expect(hashConfirmationCode('k', 2, code)).not.toBe(hashConfirmationCode('k', 1, code));
    expect(hashConfirmationCode('j', 1, code)).not.toBe(hashConfirmationCode('k', 1, code));
    expect(recipientKey('k', ' Alice@Example.com')).toBe(recipientKey('k', 'alice@example.com'));
    const mail = confirmationMail({ externalUrl: undefined }, 'a@example.com', 'alice', code);
    expect(mail.text).toContain(`Confirmation code: ${shown}`);
    expect(mail.text).toContain('asked GitQuire to send');
    expect(mail.text).toContain('No mention emails will be sent to this address unless');
  });
});

describe('mention mailer', () => {
  const config: MailConfig = {
    host: 'mail.example.com',
    port: 465,
    implicitTls: true,
    startTls: false,
    user: undefined,
    password: undefined,
    from: 'wiki@example.com',
    externalUrl: 'https://brain.example.com',
    allowedDomains: undefined,
  };

  it('links to the page with each part of its name encoded', () => {
    expect(pageLink('https://brain.example.com', 'notes/New page')).toBe(
      'https://brain.example.com/#/notes/New%20page',
    );
    expect(pageLink(undefined, 'notes/report')).toBeUndefined();
  });

  it('writes a mail that names the author, the page and the text', () => {
    const ask = comment('c1', bob, 'Can you check, @alice?', '2026-11-10T09:00:00Z', ['alice']);
    const [mention] = mentionsInMarkdown('notes/report.md', page([thread('t1', [ask])]));
    if (mention === undefined) throw new Error('expected a mention');
    const mail = mentionMail(config, 'alice@example.com', mention);
    expect(mail.to).toBe('alice@example.com');
    expect(mail.subject).toBe('bob mentioned you in report');
    expect(mail.text).toContain('On the text: "quarterly numbers"');
    expect(mail.text).toContain('Can you check, @alice?');
    expect(mail.text).toContain('Open the page: https://brain.example.com/#/notes/report');
  });

  function mailerFor(dir: string) {
    const store = createMentionReadStore(mentionStatePath(dir));
    const state: { scanClock: number; now: number; failWith: Error | null } = {
      scanClock: 0,
      now: Date.parse('2026-11-12T12:00:00Z'),
      failWith: null,
    };
    const sent: MailMessage[] = [];
    const warnings: unknown[] = [];
    const mailer = createMentionMailer({
      index: createMentionIndex(dir, () => state.scanClock),
      store,
      config,
      send: async (_config, message) => {
        if (state.failWith !== null) throw state.failWith;
        sent.push(message);
      },
      log: {
        warn: (details: unknown) => {
          warnings.push(details);
        },
      },
      now: () => state.now,
      limits: { perPersonPerDay: 3 },
    });
    return { store, state, sent, warnings, mailer };
  }

  const subscribedAt = new Date('2026-11-10T12:00:00Z');

  function addPage(dir: string, name: string, id: string): void {
    const fresh = comment(`c${id}`, bob, `Number ${id}, @alice`, '2026-11-12T08:00:00Z', ['alice']);
    writeFileSync(join(dir, name), page([thread(`t${id}`, [fresh])]));
  }

  it('mails each new unread mention once and retries a failure later', async () => {
    const dir = project();
    try {
      const { store, state, sent, warnings, mailer } = mailerFor(dir);
      expect(await mailer.round()).toBe(0);
      store.setEmail(alice, 'alice@example.com', ['t1:c1'], subscribedAt);
      expect(await mailer.round()).toBe(1);
      expect(sent.map((mail) => mail.subject)).toEqual(['bob mentioned you in plan']);
      expect(await mailer.round()).toBe(0);

      addPage(dir, 'new.md', '7');
      state.scanClock += 60_000;
      state.failWith = new Error('mail server down');
      expect(await mailer.round()).toBe(0);
      expect(warnings).toEqual([{ reason: 'mail server down', login: 'Alice' }]);
      state.failWith = null;
      expect(await mailer.round()).toBe(0);
      state.now += 3 * 60_000;
      expect(await mailer.round()).toBe(1);
      expect(sent.map((mail) => mail.to)).toEqual(['alice@example.com', 'alice@example.com']);

      addPage(dir, 'seen.md', '8');
      state.scanClock += 60_000;
      store.markRead(alice.id, ['t8:c8'], new Set(['t8:c8']));
      expect(await mailer.round()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not retry a mail the server refused for good', async () => {
    const dir = project();
    try {
      const { store, state, sent, mailer } = mailerFor(dir);
      store.setEmail(alice, 'alice@example.com', [], subscribedAt);
      state.failWith = new SmtpError('The mail server refused the recipient: 550', 550);
      expect(await mailer.round()).toBe(0);
      state.failWith = null;
      expect(await mailer.round()).toBe(0);
      expect(sent).toEqual([]);
      expect([...store.mailedIds(alice.id)]).toEqual(['t2:c3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops at the daily limit and skips people who have not been seen for a month', async () => {
    const dir = project();
    try {
      const { store, state, sent, mailer } = mailerFor(dir);
      store.setEmail(alice, 'alice@example.com', [], subscribedAt);
      for (const id of ['20', '21', '22', '23']) addPage(dir, `page-${id}.md`, id);
      state.scanClock += 60_000;
      expect(await mailer.round()).toBe(3);
      expect(await mailer.round()).toBe(0);
      state.now += 25 * 60 * 60_000;
      expect(await mailer.round()).toBe(2);
      expect(sent).toHaveLength(5);

      addPage(dir, 'late.md', '30');
      state.scanClock += 60_000;
      state.now += 40 * 24 * 60 * 60_000;
      expect(await mailer.round()).toBe(0);
      store.seen(alice, new Date(state.now));
      expect(await mailer.round()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores mentions older than the subscription that show up later', async () => {
    const dir = project();
    try {
      const { store, state, mailer } = mailerFor(dir);
      store.setEmail(alice, 'alice@example.com', ['t1:c1', 't2:c3'], subscribedAt);
      const old = comment('c40', bob, 'Old, @alice', '2026-10-01T08:00:00Z', ['alice']);
      writeFileSync(join(dir, 'restored.md'), page([thread('t40', [old])]));
      state.scanClock += 60_000;
      expect(await mailer.round()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
