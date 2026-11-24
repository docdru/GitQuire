import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveChatKeySecret } from '../chat/key-secret.ts';
import { createChatKeyStore } from '../chat/key-store.ts';
import type { HostRepo, RepoLookup } from '../host/types.ts';
import { refuseFrontDoorVolume, runGitQuireBootstrap } from '../index.ts';
import { FRONT_DOOR_LOCK, MOVING_BACK, MOVING_IN } from '../volume-markers.ts';
import {
  type AdoptDeps,
  adoptSingleWiki,
  type MoveOverSettings,
  unadoptWiki,
} from './move-over.ts';
import { openRepoTokenStore, repoTokensFile } from './repo-tokens.ts';
import { refuseSingleWikiVolume } from './start.ts';
import { openWikiTable, wikiTableFile } from './wiki-table.ts';

const SECRET = '0123456789abcdef0123456789abcdef';
const RECORD = { host: 'github' as const, id: 42, owner: 'team', ownerId: 7, name: 'wiki' };
const KEY = 'github-42';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.org',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.org',
    },
  });
}

interface Volume {
  root: string;
  data: string;
  drafts: string;
  env: Record<string, string>;
  settings: MoveOverSettings;
}

function volume(): Volume {
  const root = mkdtempSync(join(tmpdir(), 'gq-move-'));
  dirs.push(root);
  const remote = join(root, 'host', 'team', 'wiki.git');
  mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const data = join(root, 'data');
  git(root, 'clone', '-q', remote, data);
  git(data, 'config', `url.${join(root, 'host')}/.insteadOf`, 'https://git.example.org/');
  git(data, 'remote', 'set-url', 'origin', 'https://git.example.org/team/wiki.git');
  mkdirSync(join(data, 'server'));
  mkdirSync(join(data, 'wikis'));
  writeFileSync(join(data, 'server', 'page.md'), '# A page in a folder called server\n');
  writeFileSync(join(data, 'wikis', 'page.md'), '# A page in a folder called wikis\n');
  writeFileSync(join(data, 'README.md'), '# Wiki\n');
  mkdirSync(join(data, '.gitquire'), { recursive: true });
  writeFileSync(join(data, '.gitquire', '.gitignore'), 'local/\n');
  git(data, 'add', '-A');
  git(data, 'commit', '-q', '-m', 'start');
  git(data, 'push', '-q', '-u', 'origin', 'main');
  git(data, 'remote', 'set-head', 'origin', 'main');
  const state = join(data, '.gitquire', 'local', 'gitquire');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'people.json'), '{"people":[]}\n');
  writeFileSync(join(state, 'agent-tokens.json'), '{"v":1,"tokens":[]}\n');
  createChatKeyStore(data, SECRET).set(11, 'claude', 'sk-ant-secret-key-1234', new Date(0));
  const drafts = join(root, 'drafts');
  const draft = join(drafts, 'report', 'data');
  mkdirSync(join(drafts, 'report'), { recursive: true });
  git(root, 'clone', '-q', remote, draft);
  return {
    root,
    data,
    drafts,
    env: { GITQUIRE_DRAFTS_DIR: drafts, GITQUIRE_WIKIS: 'on' },
    settings: {
      host: 'github',
      dataDir: data,
      sessionSecret: SECRET,
      defaultWiki: { owner: 'team', name: 'wiki' },
      allowedOwners: new Set(['team']),
      webUrl: 'https://git.example.org',
    },
  };
}

function adoptDeps(vol: Volume, extra: Partial<AdoptDeps> = {}): AdoptDeps {
  return {
    settings: vol.settings,
    env: vol.env,
    running: () => undefined,
    host: { repoByName: async (): Promise<RepoLookup> => ({ state: 'found', repo: RECORD }) },
    now: () => Date.UTC(2026, 10, 21),
    ...extra,
  };
}

function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir)
    .filter((name) => name !== '.git')
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? tree(path, `${prefix}${name}/`)
        : [`${prefix}${name}=${readFileSync(path, 'utf8')}`];
    });
}

const run = { dryRun: false, force: false };

describe('gitquire wikis adopt', () => {
  it('a dry run changes nothing', async () => {
    const vol = volume();
    const before = tree(vol.data);
    const report = await adoptSingleWiki(adoptDeps(vol), { dryRun: true, force: false });
    expect(report.changed).toBe(false);
    expect(report.steps[0]).toMatch(/Dry run/);
    expect(report.steps.join('\n')).toContain(`wikis/${KEY}`);
    expect(tree(vol.data)).toEqual(before);
    expect(existsSync(join(vol.data, '.git'))).toBe(true);
  });

  it('moves the checkout, its state and drafts into the several-wiki layout', async () => {
    const vol = volume();
    const before = tree(vol.data);
    const report = await adoptSingleWiki(adoptDeps(vol), run);
    expect(report).toMatchObject({ changed: true, wiki: 'team/wiki', key: KEY });
    const target = join(vol.data, 'wikis', KEY);
    expect(readdirSync(vol.data).sort()).toEqual(['server', 'wikis']);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(tree(target).filter((line) => !line.includes('ai-keys'))).toEqual(
      before.filter((line) => !line.includes('ai-keys')),
    );
    expect(() => refuseSingleWikiVolume(vol.data)).not.toThrow();
    const table = openWikiTable(wikiTableFile(vol.data));
    expect(table.list()).toMatchObject([
      { key: KEY, owner: 'team', name: 'wiki', state: 'on', addedBy: 'gitquire wikis adopt' },
    ]);
    expect(table.ownerIds()).toEqual({ team: 7 });
    expect(readFileSync(join(vol.data, 'server', 'agent-tokens-github.json'), 'utf8')).toContain(
      '"v":1',
    );
    expect(statSync(join(vol.data, 'server', 'agent-tokens-github.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(vol.data, 'server')).mode & 0o777).toBe(0o700);
    expect(existsSync(join(target, '.gitquire', 'local', 'gitquire', 'agent-tokens.json'))).toBe(
      true,
    );
    const derived = deriveChatKeySecret(SECRET, KEY);
    expect(createChatKeyStore(target, derived).get(11, 'claude')).toBe('sk-ant-secret-key-1234');
    expect(createChatKeyStore(target, SECRET).get(11, 'claude')).toBeUndefined();
    expect(createChatKeyStore(target, derived).info(11).claude.savedAt).toBe(
      new Date(0).toISOString(),
    );
    const kept = join(target, '.gitquire', 'local', 'gitquire', 'ai-keys.before-wikis', '11.json');
    expect(existsSync(kept)).toBe(true);
    const copied = join(vol.data, 'wikis', '.gitquire-drafts', KEY, 'report', KEY);
    expect(existsSync(join(copied, '.git'))).toBe(true);
    expect(existsSync(join(vol.drafts, 'report', 'data', '.git'))).toBe(true);
  });

  it('is idempotent', async () => {
    const vol = volume();
    await adoptSingleWiki(adoptDeps(vol), run);
    const after = tree(vol.data);
    const again = await adoptSingleWiki(adoptDeps(vol), run);
    expect(again.changed).toBe(false);
    expect(again.steps).toEqual(['team/wiki is already moved over; nothing to do.']);
    expect(tree(vol.data)).toEqual(after);
  });

  it('finishes an interrupted re-seal of the AI keys and an interrupted draft copy', async () => {
    const vol = volume();
    await adoptSingleWiki(adoptDeps(vol), run);
    const target = join(vol.data, 'wikis', KEY);
    createChatKeyStore(target, SECRET).set(13, 'claude', 'sk-ant-not-yet-resealed');
    const copy = join(vol.data, 'wikis', '.gitquire-drafts', KEY, 'report', KEY);
    execFileSync('mv', [copy, `${copy}.partial`]);
    const again = await adoptSingleWiki(adoptDeps(vol), run);
    expect(again.changed).toBe(true);
    expect(again.steps.join('\n')).toContain('Re-sealed 1 AI key.');
    const derived = deriveChatKeySecret(SECRET, KEY);
    expect(createChatKeyStore(target, derived).get(13, 'claude')).toBe('sk-ant-not-yet-resealed');
    expect(createChatKeyStore(target, derived).get(11, 'claude')).toBe('sk-ant-secret-key-1234');
    expect(existsSync(join(copy, '.git'))).toBe(true);
    expect(existsSync(`${copy}.partial`)).toBe(false);
    expect(existsSync(join(`${copy}.interrupted-1`, '.git'))).toBe(true);
  });

  it('refuses unpushed or uncommitted edits unless forced, and then moves them along', async () => {
    const vol = volume();
    writeFileSync(join(vol.data, 'README.md'), '# Wiki, edited\n');
    git(vol.data, 'commit', '-q', '-am', 'not pushed');
    writeFileSync(join(vol.data, 'new.md'), 'typed a moment ago\n');
    await expect(adoptSingleWiki(adoptDeps(vol), run)).rejects.toThrow(
      /1 uncommitted change[\s\S]*1 commit not pushed[\s\S]*Nothing was changed/,
    );
    expect(existsSync(join(vol.data, '.git'))).toBe(true);
    const report = await adoptSingleWiki(adoptDeps(vol), { dryRun: false, force: true });
    expect(report.warnings.join('\n')).toMatch(/--force/);
    const target = join(vol.data, 'wikis', KEY);
    expect(readFileSync(join(target, 'new.md'), 'utf8')).toBe('typed a moment ago\n');
    expect(git(target, 'log', '-1', '--format=%s').trim()).toBe('not pushed');
  });

  it('refuses unpushed edits in a draft working copy', async () => {
    const vol = volume();
    writeFileSync(join(vol.drafts, 'report', 'data', 'draft.md'), 'draft edit\n');
    await expect(adoptSingleWiki(adoptDeps(vol), run)).rejects.toThrow(
      /drafts\/report\/data: 1 uncommitted change/,
    );
  });

  it('refuses a repository under an owner that is not allowed', async () => {
    const vol = volume();
    const settings = { ...vol.settings, allowedOwners: new Set(['other']) };
    await expect(adoptSingleWiki({ ...adoptDeps(vol), settings }, run)).rejects.toThrow(
      /not an allowed owner \(other\)/,
    );
    expect(existsSync(join(vol.data, '.git'))).toBe(true);
  });

  it('refuses while GitQuire runs on the volume, a checkout of another repository, and a failed lookup', async () => {
    const vol = volume();
    await expect(
      adoptSingleWiki(adoptDeps(vol, { running: () => 'process 9 holds its lock' }), run),
    ).rejects.toThrow(/still running/);
    const elsewhere = { ...vol.settings, defaultWiki: { owner: 'team', name: 'other' } };
    await expect(
      adoptSingleWiki(
        adoptDeps(vol, {
          settings: elsewhere,
          host: {
            repoByName: async (repo: HostRepo) => ({
              state: 'found',
              repo: { ...RECORD, id: 43, name: repo.name },
            }),
          },
        }),
        run,
      ),
    ).rejects.toThrow(/not a clone of team\/other/);
    await expect(
      adoptSingleWiki(
        adoptDeps(vol, { host: { repoByName: async () => ({ state: 'unreachable' }) } }),
        run,
      ),
    ).rejects.toThrow(/cannot be reached/);
    await expect(
      adoptSingleWiki(
        adoptDeps(vol, { host: { repoByName: async () => ({ state: 'gone' }) } }),
        run,
      ),
    ).rejects.toThrow(/app not installed/);
    expect(existsSync(join(vol.data, '.git'))).toBe(true);
    expect(existsSync(join(vol.data, 'server', 'wikis.json'))).toBe(false);
  });

  it('finishes a move that stopped half way', async () => {
    const vol = volume();
    const staging = join(vol.data, MOVING_IN);
    mkdirSync(staging);
    for (const name of ['.git', 'README.md']) {
      execFileSync('mv', [join(vol.data, name), join(staging, name)]);
    }
    const report = await adoptSingleWiki(adoptDeps(vol), { dryRun: false, force: true });
    expect(report.changed).toBe(true);
    const target = join(vol.data, 'wikis', KEY);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, 'server', 'page.md'))).toBe(true);
    expect(existsSync(staging)).toBe(false);
  });

  it('finishes a half-done move without --force, whichever folder holds .git, and refuses unpushed commits there', async () => {
    const vol = volume();
    const staging = join(vol.data, MOVING_IN);
    mkdirSync(staging);
    execFileSync('mv', [join(vol.data, 'README.md'), join(staging, 'README.md')]);
    const report = await adoptSingleWiki(adoptDeps(vol), run);
    expect(report.changed).toBe(true);
    const target = join(vol.data, 'wikis', KEY);
    expect(git(target, 'status', '--porcelain').trim()).toBe('');

    const other = volume();
    writeFileSync(join(other.data, 'README.md'), '# Wiki, later\n');
    git(other.data, 'commit', '-q', '-am', 'later');
    const half = join(other.data, MOVING_IN);
    mkdirSync(half);
    execFileSync('mv', [join(other.data, '.git'), join(half, '.git')]);
    await expect(
      adoptSingleWiki(adoptDeps(vol, { settings: other.settings, env: other.env }), run),
    ).rejects.toThrow(
      /interrupted move is waiting to be finished[\s\S]*1 commit not pushed[\s\S]*Pass --force/,
    );
    const forced = await adoptSingleWiki(
      adoptDeps(vol, { settings: other.settings, env: other.env }),
      { dryRun: false, force: true },
    );
    expect(forced.changed).toBe(true);
    expect(git(join(other.data, 'wikis', KEY), 'log', '-1', '--format=%s').trim()).toBe('later');
  });

  it('on Forgejo checks GITQUIRE_HOST_REPO_TOKEN already in a dry run', async () => {
    const vol = volume();
    const checked: string[] = [];
    const report = await adoptSingleWiki(
      adoptDeps(vol, {
        settings: { ...vol.settings, host: 'forgejo' },
        host: {
          repoByName: async () => ({ state: 'found', repo: { ...RECORD, host: 'forgejo' } }),
        },
        repoToken: 'wide',
        checkRepoToken: async (_repo, token) => {
          checked.push(token);
          return 'not-limited';
        },
      }),
      { dryRun: true, force: false },
    );
    expect(checked).toEqual(['wide']);
    expect(report.warnings.join('\n')).toMatch(/would not be kept \(not-limited\)/);
    expect(existsSync(join(vol.data, '.git'))).toBe(true);
  });

  it('on Forgejo keeps GITQUIRE_HOST_REPO_TOKEN as the wiki token only after the check', async () => {
    const vol = volume();
    const forgejo = { ...RECORD, host: 'forgejo' as const };
    const settings = { ...vol.settings, host: 'forgejo' as const };
    const checked: string[] = [];
    const deps = adoptDeps(vol, {
      settings,
      host: { repoByName: async () => ({ state: 'found', repo: forgejo }) },
      repoToken: 'limited',
      checkRepoToken: async (_repo, token) => {
        checked.push(token);
        return token === 'limited' ? 'ok' : 'not-limited';
      },
    });
    await adoptSingleWiki(deps, run);
    expect(checked).toEqual(['limited']);
    expect(openRepoTokenStore(repoTokensFile(vol.data), () => 'forgejo-42').has('forgejo-42')).toBe(
      true,
    );
    expect(statSync(repoTokensFile(vol.data)).mode & 0o777).toBe(0o600);

    const other = volume();
    const refused = await adoptSingleWiki(
      {
        ...deps,
        settings: { ...other.settings, host: 'forgejo' },
        env: other.env,
        repoToken: 'wide',
      },
      run,
    );
    expect(refused.warnings.join('\n')).toMatch(/is not kept \(not-limited\)/);
    expect(existsSync(repoTokensFile(other.data))).toBe(false);
    expect(openWikiTable(wikiTableFile(other.data)).list()).toHaveLength(1);
  });
});

describe('gitquire wikis adopt refuses', () => {
  it('without GITQUIRE_WIKIS=on, while the front door runs, and on another host', async () => {
    const vol = volume();
    await expect(
      adoptSingleWiki(adoptDeps(vol, { env: { ...vol.env, GITQUIRE_WIKIS: 'off' } }), run),
    ).rejects.toThrow(/GITQUIRE_WIKIS=on included/);
    mkdirSync(join(vol.data, 'server', 'x'), { recursive: true });
    writeFileSync(join(vol.data, 'server', FRONT_DOOR_LOCK), '{}');
    await expect(adoptSingleWiki(adoptDeps(vol), run)).rejects.toThrow(/front door is running/);
    rmSync(join(vol.data, 'server', FRONT_DOOR_LOCK));
    const github = { ...vol.settings, webUrl: 'https://github.com' };
    await expect(adoptSingleWiki(adoptDeps(vol, { settings: github }), run)).rejects.toThrow(
      /not a clone of team\/wiki on https:\/\/github.com/,
    );
    expect(existsSync(join(vol.data, '.git'))).toBe(true);
  });

  it('a checkout that is not on the default branch, and a GITQUIRE_BRANCH the front door would not follow', async () => {
    const vol = volume();
    await expect(
      adoptSingleWiki(adoptDeps(vol, { env: { ...vol.env, GITQUIRE_BRANCH: 'notes' } }), run),
    ).rejects.toThrow(/GITQUIRE_BRANCH is notes, but a wiki behind the front door always follows/);
    git(vol.data, 'checkout', '-q', '-b', 'notes');
    git(vol.data, 'push', '-q', '-u', 'origin', 'notes');
    await expect(adoptSingleWiki(adoptDeps(vol), run)).rejects.toThrow(
      /checkout is on notes, not on the repository's default branch main/,
    );
  });

  it('warns about saved AI keys that open with neither secret', async () => {
    const vol = volume();
    const settings = { ...vol.settings, sessionSecret: 'another-secret-of-thirty-two-chars!' };
    const report = await adoptSingleWiki(adoptDeps(vol, { settings }), run);
    expect(report.warnings.join('\n')).toMatch(/open neither with GITQUIRE_SESSION_SECRET/);
  });
});

describe('a volume in the middle of a move', () => {
  it('is refused by the single wiki, by gitquire-bootstrap before it writes, and by the front door', async () => {
    for (const marker of [MOVING_IN, MOVING_BACK]) {
      const dir = mkdtempSync(join(tmpdir(), 'gq-marker-'));
      dirs.push(dir);
      mkdirSync(join(dir, marker));
      expect(() => refuseFrontDoorVolume(dir)).toThrow(/interrupted. Run "gitquire wikis/);
      expect(() => refuseSingleWikiVolume(dir)).toThrow(/interrupted. Run "gitquire wikis/);
    }
    const moved = mkdtempSync(join(tmpdir(), 'gq-moved-'));
    dirs.push(moved);
    mkdirSync(join(moved, 'server'));
    writeFileSync(join(moved, 'server', 'wikis.json'), '{}');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(
      runGitQuireBootstrap(
        moved,
        {
          GITHUB_APP_ID: '1',
          GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
          GITQUIRE_REPO: 'team/wiki',
        },
        () => {},
      ),
    ).rejects.toThrow(/holds several wikis/);
    expect(readdirSync(moved)).toEqual(['server']);
  });
});

describe('gitquire wikis unadopt (the way back)', () => {
  it('restores the single-wiki volume and keeps the front door files', async () => {
    const vol = volume();
    const before = tree(vol.data);
    await adoptSingleWiki(adoptDeps(vol), run);
    const target = join(vol.data, 'wikis', KEY);
    const derived = deriveChatKeySecret(SECRET, KEY);
    createChatKeyStore(target, derived).set(12, 'mistral', 'mistral-key-5678');
    writeFileSync(
      join(vol.data, 'server', 'agent-tokens-github.json'),
      '{"v":1,"tokens":["door"]}\n',
    );
    const draft = join(vol.data, 'wikis', '.gitquire-drafts', KEY, 'report', KEY);
    writeFileSync(join(draft, 'later.md'), 'edited behind the front door\n');
    git(draft, 'add', 'later.md');
    git(draft, 'commit', '-q', '-m', 'later');
    git(draft, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(target, 'pull', '-q');

    const dry = await unadoptWiki(
      { settings: vol.settings, env: vol.env, running: () => undefined },
      { dryRun: true, force: false },
    );
    expect(dry.changed).toBe(false);
    expect(existsSync(join(vol.data, 'server', 'wikis.json'))).toBe(true);

    const report = await unadoptWiki(
      {
        settings: vol.settings,
        env: vol.env,
        running: () => undefined,
        now: () => Date.UTC(2026, 10, 22),
      },
      run,
    );
    expect(report.changed).toBe(true);
    expect(existsSync(join(vol.data, '.git'))).toBe(true);
    expect(() => refuseFrontDoorVolume(vol.data)).not.toThrow();
    const restored = tree(vol.data).filter(
      (line) => !line.startsWith('.gitquire/local/gitquire/') && !line.startsWith('later.md'),
    );
    expect(restored).toEqual(
      before.filter((line) => !line.startsWith('.gitquire/local/gitquire/')),
    );
    expect(readFileSync(join(vol.data, 'server', 'page.md'), 'utf8')).toContain('called server');
    const state = join(vol.data, '.gitquire', 'local', 'gitquire');
    expect(createChatKeyStore(vol.data, SECRET).get(11, 'claude')).toBe('sk-ant-secret-key-1234');
    expect(createChatKeyStore(vol.data, SECRET).get(12, 'mistral')).toBe('mistral-key-5678');
    expect(readFileSync(join(state, 'agent-tokens.json'), 'utf8')).toContain('door');
    const stamp = '2026-11-22T00-00-00-000Z';
    expect(readFileSync(join(state, `agent-tokens.json.before-single-wiki-${stamp}`), 'utf8')).toBe(
      '{"v":1,"tokens":[]}\n',
    );
    const kept = join(state, `several-wikis-${stamp}`);
    expect(existsSync(join(kept, 'server', 'wikis.json'))).toBe(true);
    expect(
      existsSync(join(kept, 'wikis', '.gitquire-drafts', KEY, 'report', KEY, 'later.md')),
    ).toBe(true);
    expect(readFileSync(join(vol.drafts, 'report', 'data', 'later.md'), 'utf8')).toBe(
      'edited behind the front door\n',
    );
    expect(existsSync(join(vol.drafts, `report.before-single-wiki-${stamp}`, 'data', '.git'))).toBe(
      true,
    );
    expect(git(vol.data, 'status', '--porcelain').trim()).toBe('');

    const again = await unadoptWiki(
      { settings: vol.settings, env: vol.env, running: () => undefined },
      run,
    );
    expect(again).toMatchObject({
      changed: false,
      steps: [`${vol.data} already holds a single wiki.`],
    });
  });

  it('adopt after unadopt moves the wiki over again', async () => {
    const vol = volume();
    await adoptSingleWiki(adoptDeps(vol), run);
    await unadoptWiki({ settings: vol.settings, env: vol.env, running: () => undefined }, run);
    const report = await adoptSingleWiki(adoptDeps(vol), run);
    expect(report.changed).toBe(true);
    expect(openWikiTable(wikiTableFile(vol.data)).list()).toHaveLength(1);
    expect(
      createChatKeyStore(join(vol.data, 'wikis', KEY), deriveChatKeySecret(SECRET, KEY)).get(
        11,
        'claude',
      ),
    ).toBe('sk-ant-secret-key-1234');
  });

  it('refuses with more than one wiki, with unpushed edits, and while running', async () => {
    const vol = volume();
    await adoptSingleWiki(adoptDeps(vol), run);
    const target = join(vol.data, 'wikis', KEY);
    writeFileSync(join(target, 'typed.md'), 'not committed\n');
    await expect(
      unadoptWiki({ settings: vol.settings, env: vol.env, running: () => undefined }, run),
    ).rejects.toThrow(/1 uncommitted change/);
    await expect(
      unadoptWiki({ settings: vol.settings, env: vol.env, running: () => 'process 3' }, run),
    ).rejects.toThrow(/still running/);
    openWikiTable(wikiTableFile(vol.data)).add({ ...RECORD, id: 43, name: 'second' }, 'alice', 0);
    await expect(
      unadoptWiki(
        { settings: vol.settings, env: vol.env, running: () => undefined },
        { dryRun: false, force: true },
      ),
    ).rejects.toThrow(/exactly one wiki; this one has 2/);
    expect(existsSync(join(vol.data, 'server', 'wikis.json'))).toBe(true);
    expect(existsSync(join(target, 'typed.md'))).toBe(true);
  });

  it('finishes a move back interrupted at any point', async () => {
    const at = async (crash: (vol: Volume) => void) => {
      const vol = volume();
      await adoptSingleWiki(adoptDeps(vol), run);
      crash(vol);
      const report = await unadoptWiki(
        { settings: vol.settings, env: vol.env, running: () => undefined },
        run,
      );
      expect(report.changed).toBe(true);
      expect(existsSync(join(vol.data, '.git'))).toBe(true);
      expect(existsSync(join(vol.data, MOVING_BACK))).toBe(false);
      expect(existsSync(join(vol.data, 'server', 'page.md'))).toBe(true);
      expect(git(vol.data, 'status', '--porcelain').trim()).toBe('');
      expect(() => refuseFrontDoorVolume(vol.data)).not.toThrow();
    };
    const back = (vol: Volume) => join(vol.data, MOVING_BACK);
    await at((vol) => {
      mkdirSync(back(vol));
      writeFileSync(join(back(vol), 'moved-back-at'), '2026-11-22T00-00-00-000Z\n');
    });
    await at((vol) => {
      mkdirSync(back(vol));
      writeFileSync(join(back(vol), 'moved-back-at'), '2026-11-22T00-00-00-000Z\n');
      execFileSync('mv', [join(vol.data, 'server'), join(back(vol), 'server')]);
    });
    await at((vol) => {
      mkdirSync(back(vol));
      writeFileSync(join(back(vol), 'moved-back-at'), '2026-11-22T00-00-00-000Z\n');
      execFileSync('mv', [join(vol.data, 'server'), join(back(vol), 'server')]);
      execFileSync('mv', [join(vol.data, 'wikis'), join(back(vol), 'wikis')]);
      writeFileSync(join(back(vol), 'parked'), 'x\n');
      const from = join(back(vol), 'wikis', KEY);
      for (const name of ['.git', 'server', 'README.md']) {
        execFileSync('mv', [join(from, name), join(vol.data, name)]);
      }
    });
  });
});
