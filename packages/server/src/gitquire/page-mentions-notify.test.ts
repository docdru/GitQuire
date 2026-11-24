import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatStatePath } from './chat-notifier.ts';
import { createMentionCounts } from './front-door/mention-counts.ts';
import type { WikiRecord } from './front-door/wiki-table.ts';
import type { MailMessage } from './mail.ts';
import { mentionStatePath } from './mentions.ts';
import { createGitQuireRoutes } from './routes.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const alice = { id: 42, login: 'alice', name: 'Alice', avatarUrl: '' };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function call(
  routes: ReturnType<typeof createGitQuireRoutes>,
  url: string,
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
  const req = {
    url,
    method: 'GET',
    headers: { host: 'brain.example.com' },
    async *[Symbol.asyncIterator]() {},
  } as unknown as IncomingMessage;
  expect(routes.handle(req, res as unknown as ServerResponse)).toBe(true);
  return promise;
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const wikiRecord: WikiRecord = {
  key: 'github-1',
  host: 'github',
  id: 1,
  owner: 'team',
  name: 'notes',
  ownerId: 7,
  state: 'on',
  formerNames: [],
  addedBy: 'github-42',
  addedAt: '2026-11-01T00:00:00.000Z',
};

const PAGE_ONLY = '# Plan\n\nAsk @alice about the budget.\n\nAnd @alice again.\n';
const WITH_COMMENT = [
  '# Plan',
  '',
  'Ask @alice about the budget[^c-7f3a].',
  '',
  '[^c-7f3a]: 💬 on "the budget"',
  '',
  '    - **@bob** · 2030-01-01 10:00 — @alice please look',
  '',
].join('\n');

function setUp() {
  const root = mkdtempSync(join(tmpdir(), 'gq-page-mentions-'));
  dirs.push(root);
  const dir = join(root, 'wikis', 'github-1');
  write(
    mentionStatePath(dir),
    JSON.stringify({
      version: 1,
      users: {
        '42': {
          read: [],
          login: 'alice',
          email: 'alice@example.com',
          since: '2020-01-01T00:00:00.000Z',
          lastSeen: new Date().toISOString(),
        },
      },
    }),
  );
  write(
    chatStatePath(dir),
    JSON.stringify({ version: 1, since: '2020-01-01T00:00:00Z', posted: [] }),
  );
  const sent: MailMessage[] = [];
  const posted: unknown[] = [];
  const routes = createGitQuireRoutes({
    projectDir: dir,
    log: silentLog,
    sessionUser: () => alice,
    notify: false,
    env: {
      GITQUIRE_SMTP_URL: 'smtps://mail.example.com',
      GITQUIRE_MAIL_FROM: 'wiki@example.com',
      GITQUIRE_EXTERNAL_URL: 'https://brain.example.com/',
      GITQUIRE_CHAT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
    },
    sendMail: async (_config, message) => {
      sent.push(message);
    },
    postToChat: async (_url, payload) => {
      posted.push(payload);
    },
  });
  return { root, dir, routes, sent, posted };
}

describe('a mention in page text', () => {
  it('never notifies: no inbox entry, no unread count, no mail, no chat message', async () => {
    const { root, dir, routes, sent, posted } = setUp();
    try {
      write(join(dir, 'plan.md'), PAGE_ONLY);
      const listed = await call(routes, '/api/gitquire/page-mentions?login=alice');
      expect((listed.body.mentions as unknown[]).length).toBe(2);
      const inbox = await call(routes, '/api/gitquire/mentions');
      expect(inbox.body).toMatchObject({ enabled: true, unread: 0, mentions: [] });
      expect(await routes.mailRound()).toBe(0);
      expect(await routes.chatRound()).toBe(0);
      expect(sent).toEqual([]);
      expect(posted).toEqual([]);
      const counts = createMentionCounts(root);
      expect(counts.unread(alice, wikiRecord)).toBe(0);
    } finally {
      routes.stop();
    }
  });

  it('is told apart from a comment mention on the same page, which does notify', async () => {
    const { dir, routes, sent, posted } = setUp();
    try {
      write(join(dir, 'plan.md'), WITH_COMMENT);
      const inbox = await call(routes, '/api/gitquire/mentions');
      expect(inbox.body.unread).toBe(1);
      expect((inbox.body.mentions as { kind: string }[]).map((m) => m.kind)).toEqual(['comment']);
      expect(await routes.mailRound()).toBe(1);
      expect(await routes.chatRound()).toBe(1);
      expect(sent).toHaveLength(1);
      expect(posted).toHaveLength(1);
      expect(sent[0]?.text).toContain('please look');
      const listed = await call(routes, '/api/gitquire/page-mentions');
      expect((listed.body.mentions as { snippet: string }[]).map((m) => m.snippet)).toEqual([
        'Ask @alice about the budget.',
      ]);
    } finally {
      routes.stop();
    }
  });
});
