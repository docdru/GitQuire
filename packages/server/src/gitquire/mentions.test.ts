import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommentThread,
  writeCommentThreads,
} from '@inkeep/open-knowledge-core/gitquire/comment-threads';
import { describe, expect, it } from 'vitest';
import type { MailConfig, MailMessage } from './mail.ts';
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

  it('stores and clears a notification address without mailing old mentions', async () => {
    const dir = project();
    const sent: MailMessage[] = [];
    const routes = createGitQuireRoutes({
      projectDir: dir,
      log: silentLog,
      sessionUser: () => ({ ...alice, name: 'Alice', avatarUrl: '' }),
      env: {
        GITQUIRE_SMTP_URL: 'smtps://mail.example.com',
        GITQUIRE_MAIL_FROM: 'wiki@example.com',
        OK_EXTERNAL_URL: 'https://brain.example.com/',
      },
      sendMail: async (_config, message) => {
        sent.push(message);
      },
      mailRoundMs: 3_600_000,
    });
    try {
      const before = await call(routes, '/api/gitquire/mentions');
      expect(before.body.email).toEqual({ available: true, address: null });
      const bad = await call(routes, '/api/gitquire/mentions/email', {
        method: 'PUT',
        body: { address: 'not an address' },
      });
      expect(bad.status).toBe(400);
      const saved = await call(routes, '/api/gitquire/mentions/email', {
        method: 'PUT',
        body: { address: ' alice@example.com ' },
      });
      expect(saved.body).toEqual({ available: true, address: 'alice@example.com' });
      expect(await routes.mailRound()).toBe(0);
      const off = await call(routes, '/api/gitquire/mentions/email', {
        method: 'PUT',
        body: { address: null },
      });
      expect(off.body).toEqual({ available: true, address: null });
    } finally {
      routes.stop();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(sent).toEqual([]);
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
      email: { available: false, address: null },
    });
    const read = await call(routes, '/api/gitquire/mentions/read', {
      method: 'POST',
      body: { all: true },
    });
    expect(read.status).toBe(401);
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

  it('mails each new unread mention once and retries after a failure', async () => {
    const dir = project();
    try {
      const store = createMentionReadStore(mentionStatePath(dir));
      let clock = 0;
      const index = createMentionIndex(dir, () => clock);
      const sent: MailMessage[] = [];
      let failing = false;
      const warnings: unknown[] = [];
      const mailer = createMentionMailer({
        index,
        store,
        config,
        send: async (_config, message) => {
          if (failing) throw new Error('mail server down');
          sent.push(message);
        },
        log: {
          warn: (details: unknown) => {
            warnings.push(details);
          },
        },
      });
      expect(await mailer.round()).toBe(0);
      store.setEmail(alice, 'alice@example.com', ['t1:c1']);
      expect(await mailer.round()).toBe(1);
      expect(sent.map((mail) => mail.subject)).toEqual(['bob mentioned you in plan']);
      expect(await mailer.round()).toBe(0);

      const fresh = comment('c7', bob, 'One more, @alice', '2026-11-12T08:00:00Z', ['alice']);
      writeFileSync(join(dir, 'new.md'), page([thread('t7', [fresh])]));
      clock += 60_000;
      failing = true;
      expect(await mailer.round()).toBe(0);
      expect(warnings).toEqual([{ reason: 'mail server down' }]);
      failing = false;
      expect(await mailer.round()).toBe(1);
      expect(sent.map((mail) => mail.to)).toEqual(['alice@example.com', 'alice@example.com']);

      const read = comment('c8', bob, 'Seen, @alice', '2026-11-12T09:00:00Z', ['alice']);
      writeFileSync(join(dir, 'seen.md'), page([thread('t8', [read])]));
      clock += 60_000;
      store.markRead(alice.id, ['t8:c8'], new Set(['t8:c8']));
      expect(await mailer.round()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
