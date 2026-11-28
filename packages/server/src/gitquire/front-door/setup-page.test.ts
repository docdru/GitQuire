import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { get, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFrontDoor } from './start.ts';

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const log = { info: () => {}, warn: () => {}, error: () => {} };

function volume(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gq-setup-'));
  dirs.push(dir);
  return dir;
}

async function start(env: Record<string, string>) {
  const running = await startFrontDoor(
    volume(),
    { PORT: '0', GITQUIRE_BIND: '127.0.0.1', ...env },
    { log, cli: [] },
  );
  stops.push(running.stop);
  const base = `http://127.0.0.1:${running.port}`;
  return {
    get: (path: string) =>
      new Promise<{ status: number; text: string }>((done, fail) => {
        get(`${base}${path}`, { agent: false }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => done({ status: res.statusCode ?? 0, text }));
        }).on('error', fail);
      }),
  };
}

describe('the set-up page', () => {
  it('answers every address with what is missing; healthy, not ready', async () => {
    const door = await start({});
    expect((await door.get('/healthz')).status).toBe(200);
    expect((await door.get('/readyz')).status).toBe(503);
    for (const path of ['/', '/w/github/team/wiki/', '/mcp/github', '/auth/github/login']) {
      const page = await door.get(path);
      expect(page.status).toBe(503);
      expect(page.text).toContain('Set up GitQuire');
      for (const name of ['GITQUIRE_EXTERNAL_URL', 'GITQUIRE_SESSION_SECRET', 'GITQUIRE_HOSTS']) {
        expect(page.text).toContain(name);
      }
      expect(page.text).toContain('&lt;GITQUIRE_EXTERNAL_URL&gt;/auth/github/callback');
    }
  });

  it('shows the exact callback address of each listed host and no value of any setting (O7)', async () => {
    const door = await start({
      GITQUIRE_EXTERNAL_URL: 'https://wiki.example.org',
      GITQUIRE_HOSTS: 'github,lab',
      GITQUIRE_HOST_GITHUB_CLIENT_SECRET: 'very-secret-value',
      GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS: 'hidden-owner',
      GITQUIRE_HOST_LAB_KIND: 'forgejo',
      GITQUIRE_HOST_LAB_TOKEN: 'bot-token-value',
    });
    const page = await door.get('/');
    expect(page.text).toContain('https://wiki.example.org/auth/github/callback');
    expect(page.text).toContain('https://wiki.example.org/auth/lab/callback');
    expect(page.text).toContain('GITQUIRE_HOST_GITHUB_CLIENT_ID');
    expect(page.text).toContain('GITQUIRE_HOST_LAB_URL');
    expect(page.text).toContain('GITQUIRE_SESSION_SECRET');
    expect(page.text).not.toContain('GITQUIRE_HOST_GITHUB_CLIENT_SECRET (or _FILE)</code></li>');
    for (const value of ['very-secret-value', 'hidden-owner', 'bot-token-value']) {
      expect(page.text).not.toContain(value);
    }
  });

  it.each(['.git', '.gitquire', '.ok', '.gitquire-moving-in'])(
    'still refuses a single-wiki volume with %s first, changing nothing (O2)',
    async (marker) => {
      const dir = volume();
      mkdirSync(join(dir, marker));
      const before = readdirSync(dir);
      await expect(startFrontDoor(dir, { PORT: '0' }, { log, cli: [] })).rejects.toThrow(
        /volume of the single-wiki mode/,
      );
      await expect(
        startFrontDoor(dir, { PORT: '0', GITQUIRE_REPO: 'team/wiki' }, { log, cli: [] }),
      ).rejects.toThrow(/volume of the single-wiki mode/);
      expect(readdirSync(dir)).toEqual(before);
    },
  );

  it('answers a websocket upgrade with 503 and closes it', async () => {
    const running = await startFrontDoor(volume(), { PORT: '0' }, { log, cli: [] });
    stops.push(running.stop);
    const status = await new Promise<number | undefined>((done) => {
      const req = request({
        host: '127.0.0.1',
        port: running.port,
        path: '/w/github/team/wiki/collab',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
        agent: false,
      });
      req.on('response', (res) => done(res.statusCode));
      req.on('upgrade', () => done(101));
      req.on('error', () => done(undefined));
      req.end();
    });
    expect(status).toBe(503);
  });

  it('stops on a wrong value or an old setting instead of showing the page', async () => {
    await expect(
      startFrontDoor(volume(), { PORT: '0', GITQUIRE_WIKIS: 'on' }, { log, cli: [] }),
    ).rejects.toThrow(/GITQUIRE_WIKIS → removed/);
    await expect(
      startFrontDoor(volume(), { PORT: '0', GITQUIRE_SESSION_SECRET: 'short' }, { log, cli: [] }),
    ).rejects.toThrow(/at least 32 characters/);
  });
});
