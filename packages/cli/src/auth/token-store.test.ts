import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fsSeam = vi.hoisted(() => ({
  stopMessage: 'process stopped partway through a file write',
  keepBytes: null as null | ((byteLength: number) => number),
  stopped: false,
  writes: null as null | Array<{ path: string; mode: number; text: string }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const stoppedMutators = Object.fromEntries(
    (
      [
        'appendFileSync',
        'chmodSync',
        'copyFileSync',
        'renameSync',
        'rmSync',
        'truncateSync',
        'unlinkSync',
        'writeSync',
      ] as const
    ).map((name) => [
      name,
      (...args: unknown[]) => {
        if (fsSeam.stopped) throw new Error(fsSeam.stopMessage);
        return (actual[name] as (...forwarded: unknown[]) => unknown)(...args);
      },
    ]),
  );
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    if (fsSeam.stopped) throw new Error(fsSeam.stopMessage);
    const keepBytes = fsSeam.keepBytes;
    if (keepBytes !== null) {
      fsSeam.keepBytes = null;
      const bytes =
        typeof data === 'string'
          ? Buffer.from(data, 'utf-8')
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      actual.writeFileSync(file, bytes.subarray(0, keepBytes(bytes.byteLength)), options);
      fsSeam.stopped = true;
      throw new Error(fsSeam.stopMessage);
    }
    actual.writeFileSync(file, data, options);
    if (fsSeam.writes !== null && typeof file === 'string') {
      fsSeam.writes.push({
        path: file,
        mode: actual.statSync(file).mode & 0o777,
        text: actual.readFileSync(file, 'utf-8'),
      });
    }
  };
  return { ...actual, ...stoppedMutators, writeFileSync };
});

type RecordedWrite = NonNullable<typeof fsSeam.writes>[number];

import { FileBackend } from './token-store.ts';

describe('FileBackend', () => {
  let tmpDir: string;
  let authFile: string;
  let store: FileBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-token-store-test-'));
    authFile = join(tmpDir, 'auth.yml');
    store = new FileBackend(authFile);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('backend property is "file"', () => {
    expect(store.backend).toBe('file');
  });

  test('get() returns null when file does not exist', async () => {
    expect(await store.get('github.com')).toBeNull();
  });

  test('set() and get() round-trip', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    const entry = await store.get('github.com');
    expect(entry).toMatchObject({ login: 'alice', token: 'gho_abc123' });
  });

  test('set() with extra fields stores them', async () => {
    await store.set('github.com', 'alice', 'gho_abc123', {
      gitProtocol: 'https',
      name: 'Alice Example',
      email: 'alice@example.com',
    });
    const entry = await store.get('github.com');
    expect(entry).toMatchObject({
      login: 'alice',
      token: 'gho_abc123',
      gitProtocol: 'https',
      name: 'Alice Example',
      email: 'alice@example.com',
    });
  });

  test('multiple hosts stored independently', async () => {
    await store.set('github.com', 'alice', 'gho_abc');
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    expect((await store.get('github.com'))?.login).toBe('alice');
    expect((await store.get('gitlab.com'))?.login).toBe('bob');
  });

  test('clear() removes entry', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    await store.clear('github.com');
    expect(await store.get('github.com')).toBeNull();
  });

  test('clear() on non-existent entry does not throw', async () => {
    await expect(store.clear('nonexistent.com')).resolves.toBeUndefined();
  });

  test('set() overwrites previous value', async () => {
    await store.set('github.com', 'alice', 'gho_old');
    await store.set('github.com', 'alice', 'gho_new');
    const entry = await store.get('github.com');
    expect(entry?.token).toBe('gho_new');
  });

  test('auth.yml file has mode 0600', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    const stat = Bun.file(authFile);
    expect(await stat.exists()).toBe(true);
    const { statSync } = await import('node:fs');
    const mode = statSync(authFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('file contents are valid YAML with hostname keys', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    const raw = readFileSync(authFile, 'utf-8');
    expect(raw).toContain('github.com');
    expect(raw).toContain('gitlab.com');
    expect(raw).toContain('gho_abc123');
    expect(raw).toContain('glpat_xyz');
  });

  test('get() returns null for non-stored host after writing other hosts', async () => {
    await store.set('github.com', 'alice', 'gho_abc');
    expect(await store.get('bitbucket.org')).toBeNull();
  });

  test('handles corrupt YAML file gracefully', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(authFile, '{{{{ not valid yaml }}}}');
    expect(await store.get('github.com')).toBeNull();
  });

  test('creates parent directory if missing', async () => {
    const nestedFile = join(tmpDir, 'deep', 'nested', 'auth.yml');
    const nestedStore = new FileBackend(nestedFile);
    await nestedStore.set('github.com', 'alice', 'gho_abc');
    expect(await nestedStore.get('github.com')).toMatchObject({ login: 'alice' });
  });
});

const SEEDED_AUTH_YML = [
  'github.com:',
  '  login: alice',
  '  token: gho_alice',
  'gitlab.com:',
  '  login: bob',
  '  token: glpat_bob',
  '',
].join('\n');

const SEEDED_ENTRIES = {
  'github.com': { login: 'alice', token: 'gho_alice' },
  'gitlab.com': { login: 'bob', token: 'glpat_bob' },
};

const CREDENTIAL_TOKENS = ['gho_alice', 'glpat_bob', 'cb_carol'];

const authFileWrites = [
  {
    operation: 'set()',
    run: (store: FileBackend) => store.set('codeberg.org', 'carol', 'cb_carol'),
  },
  { operation: 'clear()', run: (store: FileBackend) => store.clear('github.com') },
];

const stopPoints = [
  { at: 'before its first byte', keepBytes: () => 0 },
  { at: 'halfway through', keepBytes: (byteLength: number) => Math.floor(byteLength / 2) },
  { at: 'one byte before the end', keepBytes: (byteLength: number) => byteLength - 1 },
];

describe.each(authFileWrites)('FileBackend $operation auth.yml write', ({ run }) => {
  let tmpDir: string;
  let authFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-token-store-write-'));
    authFile = join(tmpDir, 'auth.yml');
    writeFileSync(authFile, SEEDED_AUTH_YML, { mode: 0o600 });
  });

  afterEach(() => {
    fsSeam.keepBytes = null;
    fsSeam.stopped = false;
    fsSeam.writes = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.each(stopPoints)(
    'stopped $at leaves every previous entry readable and the file bytes unchanged',
    async ({ keepBytes }) => {
      fsSeam.keepBytes = keepBytes;
      await expect(run(new FileBackend(authFile))).rejects.toThrow(fsSeam.stopMessage);

      const reopened = new FileBackend(authFile);
      expect({
        'github.com': await reopened.get('github.com'),
        'gitlab.com': await reopened.get('gitlab.com'),
      }).toEqual(SEEDED_ENTRIES);
      expect(readFileSync(authFile, 'utf-8')).toBe(SEEDED_AUTH_YML);
    },
  );

  test('leaves a group-readable auth.yml holding credentials at mode 0600', async () => {
    chmodSync(authFile, 0o644);

    await run(new FileBackend(authFile));

    expect(await new FileBackend(authFile).get('gitlab.com')).toEqual(SEEDED_ENTRIES['gitlab.com']);
    expect((statSync(authFile).mode & 0o777).toString(8)).toBe('600');
  });

  test('puts credential bytes only into files without group or other permission bits', async () => {
    chmodSync(authFile, 0o644);
    const writes: RecordedWrite[] = [];
    fsSeam.writes = writes;

    await run(new FileBackend(authFile));

    const holdingCredentials = writes.filter((write) =>
      CREDENTIAL_TOKENS.some((token) => write.text.includes(token)),
    );
    expect(holdingCredentials.length).toBeGreaterThan(0);
    expect(
      holdingCredentials
        .filter((write) => (write.mode & 0o077) !== 0)
        .map((write) => `${basename(write.path)} mode ${write.mode.toString(8)}`),
    ).toEqual([]);
  });
});

describe('createTokenStore', () => {
  test('returns a file-backed store', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(
      join(mkdtempSync(join(tmpdir(), 'ok-ts-smoke-')), 'auth.yml'),
    );
    expect(store.backend).toBe('file');
    expect(typeof store.get).toBe('function');
    expect(typeof store.set).toBe('function');
    expect(typeof store.clear).toBe('function');
  });

  test('persists credentials to the given auth file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-ts-persist-'));
    const authFile = join(dir, 'auth.yml');
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(authFile);
    await store.set('github.com', 'alice', 'gho_persisted');
    expect(readFileSync(authFile, 'utf-8')).toContain('gho_persisted');
    await store.clear('github.com');
    expect(await store.get('github.com')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('clearStoredToken', () => {
  let tmpDir: string;
  let authFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-ts-clear-'));
    authFile = join(tmpDir, 'auth.yml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns false and creates no file when nothing is stored', async () => {
    const { clearStoredToken } = await import('./token-store.ts');
    expect(await clearStoredToken('github.com', authFile)).toBe(false);
    const { existsSync } = await import('node:fs');
    expect(existsSync(authFile)).toBe(false);
  });

  test('clears the file entry and returns true', async () => {
    const { FileBackend, clearStoredToken } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'alice', 'gho_file_only');

    expect(await clearStoredToken('github.com', authFile)).toBe(true);
    expect(await new FileBackend(authFile).get('github.com')).toBeNull();
  });

  test('per-host scoping — clearing github.com leaves gitlab.com intact', async () => {
    const { FileBackend, clearStoredToken } = await import('./token-store.ts');
    const file = new FileBackend(authFile);
    await file.set('github.com', 'alice', 'gho_gh');
    await file.set('gitlab.com', 'bob', 'glpat_gl');

    expect(await clearStoredToken('github.com', authFile)).toBe(true);
    expect(await file.get('github.com')).toBeNull();
    expect((await file.get('gitlab.com'))?.token).toBe('glpat_gl');
  });
});

describe('credentials per channel', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ok-ts-channel-'));
    vi.stubEnv('HOME', fakeHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('Stable keeps ~/.gitquire/auth.yml', async () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
    const { FileBackend: ChannelFileBackend } = await import('./token-store.ts');
    await new ChannelFileBackend().set('github.com', 'a', 't');
    expect(readFileSync(join(fakeHome, '.gitquire', 'auth.yml'), 'utf-8')).toContain('github.com');
  });

  test('Beta uses ~/.gitquire-beta/auth.yml, sharing nothing', async () => {
    vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
    const { FileBackend: ChannelFileBackend } = await import('./token-store.ts');
    await new ChannelFileBackend().set('github.com', 'a', 't');
    expect(readFileSync(join(fakeHome, '.gitquire-beta', 'auth.yml'), 'utf-8')).toContain(
      'github.com',
    );
    expect(() => readFileSync(join(fakeHome, '.gitquire', 'auth.yml'), 'utf-8')).toThrow();
  });
});
