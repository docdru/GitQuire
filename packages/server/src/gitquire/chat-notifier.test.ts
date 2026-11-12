import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChatPostError,
  chatMessage,
  chatPayload,
  createChatNotifier,
  guessChatFormat,
  postToChat,
  resolveChatConfig,
} from './chat-notifier.ts';
import type { Mention } from './mentions.ts';

function mention(id: string, at: string, body = 'Can you check <this> & that, @alice?'): Mention {
  return {
    id,
    path: 'notes/Quarterly report.md',
    docName: 'notes/Quarterly report',
    threadId: id.split(':')[0] as string,
    commentId: id.split(':')[1] as string,
    author: { id: 'github-2', login: 'bob', name: 'Bob' },
    at,
    body,
    quote: 'the numbers',
    resolved: false,
    logins: ['alice'],
  };
}

const silentLog = { warn: () => {}, info: () => {} };
const external = 'https://wiki.example.com';

describe('chat settings', () => {
  it('is off without a URL and refuses plain http to other hosts', () => {
    expect(resolveChatConfig({})).toEqual({ kind: 'off' });
    expect(resolveChatConfig({ GITQUIRE_CHAT_WEBHOOK_URL: 'not a url' }).kind).toBe('invalid');
    const plain = resolveChatConfig({ GITQUIRE_CHAT_WEBHOOK_URL: 'http://chat.example.com/x' });
    expect(plain.kind).toBe('invalid');
    const local = resolveChatConfig({ GITQUIRE_CHAT_WEBHOOK_URL: 'http://localhost:9000/x' });
    expect(local.kind).toBe('on');
    const bad = resolveChatConfig({
      GITQUIRE_CHAT_WEBHOOK_URL: 'https://chat.example.com/x',
      GITQUIRE_CHAT_FORMAT: 'irc',
    });
    expect(bad.kind).toBe('invalid');
  });

  it('picks the format from the address unless it is set', () => {
    expect(guessChatFormat(new URL('https://hooks.slack.com/services/T/B/x'))).toBe('slack');
    expect(guessChatFormat(new URL('https://discord.com/api/webhooks/1/x'))).toBe('discord');
    expect(guessChatFormat(new URL('https://acme.webhook.office.com/webhookb2/x'))).toBe('teams');
    expect(guessChatFormat(new URL('https://prod-1.westeurope.logic.azure.com/x'))).toBe('teams');
    expect(guessChatFormat(new URL('https://chat.acme.com/hooks/abc'))).toBe('slack');
    expect(guessChatFormat(new URL('https://matrix.acme.com/webhook/abc'))).toBe('generic');
    const forced = resolveChatConfig({
      GITQUIRE_CHAT_WEBHOOK_URL: 'https://chat.acme.com/hooks/abc',
      GITQUIRE_CHAT_FORMAT: 'Generic',
      OK_EXTERNAL_URL: `${external}/`,
    });
    expect(forced).toEqual({
      kind: 'on',
      config: { url: 'https://chat.acme.com/hooks/abc', format: 'generic', externalUrl: external },
    });
  });
});

describe('chat messages', () => {
  const message = chatMessage({ externalUrl: external }, mention('t1:c1', '2026-11-12T09:00:00Z'));

  it('names the author, the mentioned people, the page and links to it', () => {
    expect(message).toEqual({
      who: 'Bob',
      page: 'Quarterly report',
      docName: 'notes/Quarterly report',
      link: 'https://wiki.example.com/#/notes/Quarterly%20report',
      mentioned: ['@alice'],
      quote: 'the numbers',
      comment: 'Can you check <this> & that, @alice?',
    });
  });

  it('formats for Slack with escaping and a link', () => {
    const link = '<https://wiki.example.com/#/notes/Quarterly%20report|Quarterly report>';
    const quote = '> Can you check &lt;this&gt; &amp; that, @alice?';
    const text = `Bob mentioned @alice in ${link}\n${quote}`;
    expect(chatPayload('slack', message)).toEqual({ text });
  });

  it('formats for Discord without pinging anyone', () => {
    const payload = chatPayload('discord', message) as {
      content: string;
      allowed_mentions: unknown;
    };
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content).toContain('Bob mentioned @alice in Quarterly report (https://');
  });

  it('formats for Teams as a card with a button', () => {
    const payload = chatPayload('teams', message) as {
      attachments: { content: { body: { text: string }[]; actions: { url: string }[] } }[];
    };
    const card = payload.attachments[0]?.content;
    expect(card?.body[0]?.text).toBe('Bob mentioned @alice in Quarterly report');
    expect(card?.actions[0]?.url).toBe(message.link);
    const noLink = chatPayload('teams', { ...message, link: undefined }) as typeof payload;
    expect(noLink.attachments[0]?.content.actions).toEqual([]);
  });

  it('sends plain JSON to other services', () => {
    expect(chatPayload('generic', message)).toMatchObject({
      event: 'mention',
      author: 'Bob',
      mentioned: ['@alice'],
      url: message.link,
    });
  });
});

describe('chat notifier', () => {
  function setup(mentions: Mention[]) {
    const dir = mkdtempSync(join(tmpdir(), 'gq-chat-'));
    const posts: unknown[] = [];
    const state = { mentions, fail: undefined as ChatPostError | undefined, clock: 0 };
    const notifier = createChatNotifier({
      index: { all: () => state.mentions },
      config: { url: 'https://chat.example.com/hooks/x', format: 'generic', externalUrl: external },
      stateFile: join(dir, 'chat.json'),
      post: async (_url, payload) => {
        if (state.fail !== undefined) throw state.fail;
        posts.push(payload);
      },
      log: silentLog,
      now: () => state.clock,
    });
    return { dir, posts, state, notifier };
  }

  it('starts with the mentions that exist and then posts each new one once', async () => {
    const { dir, posts, state, notifier } = setup([mention('t1:c1', '2026-11-12T09:00:00Z')]);
    try {
      expect(await notifier.round()).toBe(0);
      expect(posts).toEqual([]);
      state.mentions = [
        ...state.mentions,
        mention('t2:c2', '2026-11-12T10:00:00Z'),
        mention('t3:c3', '2026-11-12T09:30:00Z'),
      ];
      expect(await notifier.round()).toBe(2);
      expect(posts.map((post) => (post as { docName: string }).docName)).toHaveLength(2);
      expect(await notifier.round()).toBe(0);
      const saved = JSON.parse(readFileSync(join(dir, 'chat.json'), 'utf8'));
      expect(saved.posted.sort()).toEqual(['t1:c1', 't2:c2', 't3:c3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits after a failure and drops a mention the webhook refuses for good', async () => {
    const { dir, posts, state, notifier } = setup([]);
    try {
      await notifier.round();
      state.mentions = [mention('t1:c1', '2026-11-12T09:00:00Z')];
      state.fail = new ChatPostError('down', 503);
      expect(await notifier.round()).toBe(0);
      state.fail = undefined;
      expect(await notifier.round()).toBe(0);
      state.clock += 3 * 60_000;
      expect(await notifier.round()).toBe(1);
      state.mentions = [...state.mentions, mention('t2:c2', '2026-11-12T10:00:00Z')];
      state.fail = new ChatPostError('gone', 404);
      expect(await notifier.round()).toBe(0);
      state.fail = undefined;
      expect(await notifier.round()).toBe(0);
      expect(posts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

describe('posting', () => {
  it('posts JSON and reports an error answer', async () => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push(`${req.headers['content-type']} ${body}`);
        res.statusCode = req.url === '/fail' ? 410 : 200;
        res.end('ok');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a port');
    await postToChat(`http://127.0.0.1:${address.port}/ok`, { text: 'hi' });
    expect(received).toEqual(['application/json {"text":"hi"}']);
    const failure = await postToChat(`http://127.0.0.1:${address.port}/fail`, {}).catch(
      (err) => err,
    );
    expect(failure).toBeInstanceOf(ChatPostError);
    expect(failure.status).toBe(410);
  });
});
