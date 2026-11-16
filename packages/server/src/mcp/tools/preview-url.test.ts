import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LOCAL_DIR, OK_DIR } from '@gitquire/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  acquireServerLock,
  markServerLockDraining,
  updateServerLockPort,
} from '../../server-lock.ts';
import { buildPreviewAttachWarning, resolvePreviewUrl, resolveUiInfo } from './preview-url.ts';

let tmpDir: string;
let lockDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-preview-url-'));
  lockDir = resolve(tmpDir, OK_DIR, LOCAL_DIR);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function seedUiServer(port = 5173, url?: string): void {
  acquireServerLock(lockDir, {
    port: 0,
    worktreeRoot: tmpDir,
    capabilities: ['http', 'ws', 'ui'],
  });
  updateServerLockPort(lockDir, port, url);
}

describe('resolvePreviewUrl — lock edges', () => {
  test('lock returns route-only url when a ui-capable server.lock is bound', () => {
    seedUiServer(5173);
    const result = resolvePreviewUrl('docs/a', { lockDir });
    expect(result).toEqual({ url: '/#/docs/a', source: 'lock' });
  });

  test('lock with port=0 returns null (no further sources)', () => {
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: tmpDir,
      capabilities: ['http', 'ws', 'ui'],
    });
    const result = resolvePreviewUrl('docs/a', { lockDir });
    expect(result).toBeNull();
  });

  test('route is identical regardless of the lock port', () => {
    seedUiServer(4242);
    const result = resolvePreviewUrl('docs/a', { lockDir });
    expect(result?.url).toBe('/#/docs/a');
  });

  test('null when no lock present', () => {
    const result = resolvePreviewUrl('docs/a', { lockDir });
    expect(result).toBeNull();
  });

  test('never emits openknowledge:// scheme — the url is a bare route', () => {
    const prior = process.env.GITQUIRE_ELECTRON_PROTOCOL_HOST;
    try {
      process.env.GITQUIRE_ELECTRON_PROTOCOL_HOST = '1';
      seedUiServer(5173);
      const result = resolvePreviewUrl('docs/a', { lockDir });
      expect(result?.source).toBe('lock');
      expect(result?.url.startsWith('/#/')).toBe(true);
      expect(result?.url.startsWith('openknowledge://')).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.GITQUIRE_ELECTRON_PROTOCOL_HOST;
      else process.env.GITQUIRE_ELECTRON_PROTOCOL_HOST = prior;
    }
  });
});

describe('resolvePreviewUrl — docName encoding (via lock branch)', () => {
  beforeEach(() => {
    seedUiServer(5173);
  });

  test('simple nested path', () => {
    const result = resolvePreviewUrl('notes/meeting', { lockDir });
    expect(result?.url).toBe('/#/notes/meeting');
  });

  test('spaces and em-dashes encoded', () => {
    const result = resolvePreviewUrl('notes/My Doc — 2026', { lockDir });
    expect(result?.url).toBe('/#/notes/My%20Doc%20%E2%80%94%202026');
  });

  test('question marks and hash signs encoded per-segment', () => {
    const result = resolvePreviewUrl('weird/? name', { lockDir });
    expect(result?.url).toBe('/#/weird/%3F%20name');
  });

  test('percent literal encoded', () => {
    const result = resolvePreviewUrl('with%percent', { lockDir });
    expect(result?.url).toBe('/#/with%25percent');
  });
});

describe('resolvePreviewUrl — round-trip via docNameFromHash', () => {
  function docNameFromHash(hash: string): string | null {
    if (!hash.startsWith('#/')) return null;
    const rest = hash.slice(2);
    const qmark = rest.indexOf('?');
    const encoded = qmark >= 0 ? rest.slice(0, qmark) : rest;
    if (!encoded) return null;
    try {
      return encoded.split('/').map(decodeURIComponent).join('/');
    } catch {
      return encoded;
    }
  }

  beforeEach(() => {
    seedUiServer(5173);
  });

  test.each([
    'docs/a',
    'notes/My Doc — 2026',
    'weird/name with spaces',
    'with#hash',
    'with%percent',
    'deeply/nested/path/here',
    'leading-dash',
    'unicode/日本語',
  ])('round-trip: %s', (docName: string) => {
    const result = resolvePreviewUrl(docName, { lockDir });
    expect(result).not.toBeNull();
    const hashIdx = result?.url.indexOf('#') ?? -1;
    expect(hashIdx).toBeGreaterThan(-1);
    const hash = result?.url.slice(hashIdx);
    const decoded = docNameFromHash(hash ?? '');
    expect(decoded).toBe(docName);
  });

  test('trailing slash docName: decoder is lossy but safe', () => {
    const result = resolvePreviewUrl('trail/', { lockDir });
    const hash = result?.url.slice(result.url.indexOf('#'));
    expect(hash).toBe('#/trail/');
  });
});

describe('resolveUiInfo — server.lock source', () => {
  test('a server.lock advertising the ui surface yields its dialable origin', () => {
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: tmpDir,
      capabilities: ['http', 'ws', 'ui'],
    });
    updateServerLockPort(lockDir, 6060, 'http://127.0.0.1:6060');
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: 'http://127.0.0.1:6060' });
  });

  test('a server.lock with no capabilities field is treated as ui-capable (optimistic)', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: tmpDir });
    updateServerLockPort(lockDir, 6061, 'http://127.0.0.1:6061');
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: 'http://127.0.0.1:6061' });
  });

  test('a server.lock that explicitly omits the ui surface yields a null base', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: tmpDir, capabilities: ['http', 'ws'] });
    updateServerLockPort(lockDir, 6060, 'http://127.0.0.1:6060');
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: null });
  });

  test('a ui-capable server.lock with no dialable origin (pre-bind, port 0) yields a null base', () => {
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: tmpDir,
      capabilities: ['http', 'ws', 'ui'],
    });
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: null });
  });

  test('a draining ui-capable server.lock is never returned', () => {
    acquireServerLock(lockDir, {
      port: 0,
      worktreeRoot: tmpDir,
      capabilities: ['http', 'ws', 'ui'],
    });
    updateServerLockPort(lockDir, 6060, 'http://127.0.0.1:6060');
    markServerLockDraining(lockDir);
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: null });
  });

  test('no lock at all yields a null base', () => {
    expect(resolveUiInfo({ lockDir })).toEqual({ baseUrl: null });
  });
});

describe('buildPreviewAttachWarning — names the running channel command', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('Stable text is byte-identical', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    expect(buildPreviewAttachWarning(null, true).message).toBe(
      'No UI is running for this project. Start one to see the preview: `gq start` (terminal), or open the project in OK Electron.',
    );
    expect(buildPreviewAttachWarning({ url: '/#/a' }, true).message).toMatch(
      /on a stdio CLI with no browser, `gq open <doc>`\.$/,
    );
  });

  test('Beta names gq-beta', () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    expect(buildPreviewAttachWarning(null, true).message).toContain('`gq-beta start` (terminal)');
    expect(buildPreviewAttachWarning({ url: '/#/a' }, true).message).toMatch(
      /on a stdio CLI with no browser, `gq-beta open <doc>`\.$/,
    );
  });
});
