import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { loadConfig } from '../config/loader.ts';
import { OK_DIR } from '../constants.ts';
import { previewContent } from '../content/preview.ts';
import {
  applySharingMode,
  buildInitJsonSummary,
  ContentDirError,
  formatInitResult,
  formatSharingOutcome,
  HomeProjectRootError,
  initCommand,
  resolveRequestedContentDir,
  resolveSharingMode,
  runInit as runInitProduct,
} from './init.ts';

beforeEach(() => {
  vi.stubEnv('OK_CHANNEL', 'stable');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function runInit(...args: Parameters<typeof runInitProduct>) {
  const result = await runInitProduct(...args);
  if (result.didGitInit || existsSync(join(result.projectRoot, '.git', 'config'))) {
    configureTestGitRepository(result.projectRoot);
  }
  return result;
}

describe('runInit', () => {
  let testDir: string;
  let fakeHome: string;
  const originalHome = process.env.HOME;
  const runInitForTest = async (options: Parameters<typeof runInit>[0] = {}) =>
    runInit({ cwd: testDir, home: fakeHome, ...options });

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `init-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    vi.unstubAllEnvs();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('scaffolds .ok/ and points at ok start', async () => {
    const result = await runInitForTest();
    expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
    expect(formatInitResult(result, testDir)).toContain('start');
  });

  it('is idempotent — running twice produces the same end state', async () => {
    await runInitForTest();
    const config = readFileSync(join(testDir, OK_DIR, 'config.yml'), 'utf-8');
    const second = await runInitForTest();
    expect(readFileSync(join(testDir, OK_DIR, 'config.yml'), 'utf-8')).toBe(config);
    expect(second.contentCreated).toEqual([]);
  });

  it('accepts the retired --no-mcp and --no-skills flags without failing', () => {
    const cmd = initCommand().exitOverride();
    expect(() => cmd.parseOptions(['--no-mcp', '--no-skills'])).not.toThrow();
  });

  describe('content preview in init output', () => {
    it('renders Content block with file count and sample when preview succeeds', async () => {
      writeFileSync(join(testDir, 'readme.md'), '# Readme');
      mkdirSync(join(testDir, 'docs'));
      writeFileSync(join(testDir, 'docs', 'guide.md'), '# Guide');

      const result = await runInitForTest();

      const preview = previewContent({
        projectDir: testDir,
        contentDir: testDir,
      });
      result.preview = preview;

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Content:');
      expect(output).toContain(`Found ${preview.totalCount} markdown files`);
      expect(output).toContain('Re-check anytime: open-knowledge preview');
    });

    it('renders warning line when preview is undefined with previewWarning', async () => {
      const result = await runInitForTest();
      result.preview = undefined;
      result.previewWarning = 'something went wrong';

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Content preview unavailable: something went wrong');
      expect(output).not.toContain('Found');
    });

    it('omits Sample line when preview.totalCount is 0', async () => {
      const result = await runInitForTest();
      result.preview = {
        totalCount: 0,
        sample: [],
        contentDir: testDir,
        warnings: [],
      };

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Found 0 markdown files');
      expect(output).not.toContain('Sample:');
    });

    it('loadConfig + previewContent integration: preview picks up scaffolded config', async () => {
      writeFileSync(join(testDir, 'readme.md'), '# Readme');
      mkdirSync(join(testDir, 'docs'));
      writeFileSync(join(testDir, 'docs', 'guide.md'), '# Guide');

      const result = await runInitForTest();

      const { config } = loadConfig(testDir);
      const contentDir = resolve(testDir, config.content.dir);
      const preview = previewContent({
        projectDir: testDir,
        contentDir,
      });
      result.preview = preview;

      expect(preview.totalCount).toBeGreaterThanOrEqual(2);
      expect(preview.sample.some((p) => p.includes('readme.md'))).toBe(true);

      const output = formatInitResult(result, testDir);
      expect(output).toContain('Content:');
      expect(output).toContain(`Found ${preview.totalCount} markdown files`);
    });
  });

  describe('ensureProjectGit wiring (US-005)', () => {
    it.each(['main', 'trunk'])(
      'initializes the configured %s branch without a misleading label',
      async (branch) => {
        const gitConfig = join(fakeHome, 'gitconfig');
        writeFileSync(gitConfig, `[init]\n\tdefaultBranch = ${branch}\n`);
        vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
        vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');

        const result = await runInitForTest();

        expect(result.didGitInit).toBe(true);
        const head = readFileSync(join(testDir, '.git/HEAD'), 'utf-8');
        expect(head).toBe(`ref: refs/heads/${branch}\n`);

        const output = formatInitResult(result, testDir);
        expect(output.split('\n').find((line) => line.startsWith('Initialized git repo at'))).toBe(
          `Initialized git repo at ${testDir}/.git/`,
        );
      },
    );

    it('pre-existing .git/HEAD → runInit does not re-init and reports didGitInit=false', async () => {
      mkdirSync(join(testDir, '.git'));
      writeFileSync(join(testDir, '.git/HEAD'), 'ref: refs/heads/main\n');

      const result = await runInitForTest();

      expect(result.didGitInit).toBe(false);
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Initialized git repo at');
    });

    it('fresh tmpdir → also seeds project-root .gitignore with .DS_Store', async () => {
      const result = await runInitForTest();

      expect(result.didGitInit).toBe(true);
      expect(result.rootGitignoreCreated).toBe(true);
      const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.DS_Store');

      const output = formatInitResult(result, testDir);
      expect(output).toContain(`Seeded .gitignore at ${testDir}/.gitignore (.DS_Store)`);
    });

    it('pre-existing .git/ → leaves a hand-authored .gitignore completely alone', async () => {
      mkdirSync(join(testDir, '.git'));
      writeFileSync(join(testDir, '.git/HEAD'), 'ref: refs/heads/main\n');
      const original = '# user-authored\nnode_modules/\n';
      writeFileSync(join(testDir, '.gitignore'), original, 'utf-8');

      const result = await runInitForTest();

      expect(result.didGitInit).toBe(false);
      expect(result.rootGitignoreCreated).toBe(false);
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Seeded .gitignore');
      expect(readFileSync(join(testDir, '.gitignore'), 'utf-8')).toBe(original);
    });

    it('fresh tmpdir WITH a pre-existing .gitignore → .DS_Store seed skipped, file untouched', async () => {
      const original = 'secrets.env\n';
      writeFileSync(join(testDir, '.gitignore'), original, 'utf-8');

      const result = await runInitForTest();

      expect(result.didGitInit).toBe(true);
      expect(result.rootGitignoreCreated).toBe(false);
      expect(readFileSync(join(testDir, '.gitignore'), 'utf-8')).toBe(original);
      const output = formatInitResult(result, testDir);
      expect(output).not.toContain('Seeded .gitignore');
    });

    it('symlink at .gitignore → seed helper throws but runInit completes (non-fatal contract)', async () => {
      const sentinel = join(testDir, 'sentinel.txt');
      writeFileSync(sentinel, 'do-not-clobber', 'utf-8');
      symlinkSync(sentinel, join(testDir, '.gitignore'));

      const result = await runInitForTest();

      expect(result.didGitInit).toBe(true);
      expect(result.rootGitignoreCreated).toBe(false);
      expect(existsSync(join(testDir, OK_DIR, 'config.yml'))).toBe(true);
      expect(readFileSync(sentinel, 'utf-8')).toBe('do-not-clobber');
    });

    it('git unusable everywhere → runInit surfaces the recoverable GitNotAvailableError (no content scaffolded)', async () => {
      const originalPath = process.env.PATH;
      const originalPlatform = process.platform;
      process.env.PATH = '/nonexistent';
      Object.defineProperty(process, 'platform', {
        value: originalPlatform === 'win32' ? 'linux' : 'win32',
        configurable: true,
      });
      try {
        const { GitNotAvailableError } = await import('@inkeep/open-knowledge-server');
        await expect(runInitForTest()).rejects.toBeInstanceOf(GitNotAvailableError);
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
        process.env.PATH = originalPath;
      }

      expect(existsSync(join(testDir, OK_DIR))).toBe(false);
      expect(existsSync(join(testDir, '.git'))).toBe(false);
    });
  });
});

describe('runInit — projectRoot threading', () => {
  let testDir: string;
  let fakeHome: string;
  const originalHome = process.env.HOME;
  const originalPlatform = process.platform;

  beforeEach(() => {
    const rawDir = resolve(
      tmpdir(),
      `init-projectroot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(rawDir, { recursive: true });
    testDir = realpathSync(rawDir);
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    process.env.HOME = fakeHome;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns projectRoot equal to git root when cwd sits in a sub-folder', async () => {
    const repo = join(fakeHome, 'repo');
    const sub = join(repo, 'sub');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);
    expect(existsSync(join(repo, '.git'))).toBe(true);

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
    });

    expect(result.projectRoot).toBe(repo);
    expect(existsSync(join(repo, OK_DIR))).toBe(true);
    expect(existsSync(join(sub, OK_DIR))).toBe(false);
    expect(result.gitRootPromoted).toBe(true);
    expect(result.promotedFromDir).toBe('sub');
    const output = formatInitResult(result, result.projectRoot);
    expect(output).toContain('Content scope promoted to the git repo root');
    expect(output).toContain('content.dir: sub');
  });

  it('returns projectRoot equal to cwd when cwd is the git root', async () => {
    const repo = join(fakeHome, 'flat-repo');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);

    const result = await runInit({
      cwd: repo,
      home: fakeHome,
    });

    expect(result.projectRoot).toBe(repo);
    expect(existsSync(join(repo, OK_DIR))).toBe(true);
    expect(result.gitRootPromoted).toBe(false);
    expect(result.promotedFromDir).toBeUndefined();
    const output = formatInitResult(result, result.projectRoot);
    expect(output).not.toContain('Content scope promoted to the git repo root');
  });

  it('loadConfig succeeds when called against the resolved projectRoot', async () => {
    const repo = join(fakeHome, 'repo-loadconfig');
    const sub = join(repo, 'subdir');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
    });

    expect(result.projectRoot).toBe(repo);
    expect(existsSync(join(repo, OK_DIR, 'config.yml'))).toBe(true);
    const { config: rootConfig } = loadConfig(result.projectRoot);
    expect(rootConfig).toBeDefined();
    expect(rootConfig.content.dir).toBe('.');
  });

  it('--content-dir . from a sub-folder narrows scope to that folder', async () => {
    const repo = join(fakeHome, 'repo-cd-dot');
    const sub = join(repo, 'notes');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      contentDir: '.',
    });

    expect(result.projectRoot).toBe(repo);
    expect(result.gitRootPromoted).toBe(true);
    expect(result.contentDir).toBe('notes');
    const { config } = loadConfig(result.projectRoot);
    expect(config.content.dir).toBe('notes');

    const output = formatInitResult(result, result.projectRoot);
    expect(output).not.toContain('Content scope promoted to the git repo root');
    expect(output).toContain('Content scope set to notes/');
  });

  it('--content-dir <subpath> narrows scope relative to cwd', async () => {
    const repo = join(fakeHome, 'repo-cd-sub');
    const nested = join(repo, 'docs', 'guides');
    mkdirSync(nested, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);

    const result = await runInit({
      cwd: repo,
      home: fakeHome,
      contentDir: 'docs/guides',
    });

    expect(result.projectRoot).toBe(repo);
    expect(result.contentDir).toBe('docs/guides');
    const { config } = loadConfig(result.projectRoot);
    expect(config.content.dir).toBe('docs/guides');
  });

  it('--content-dir outside the project root throws ContentDirError', async () => {
    const repo = join(fakeHome, 'repo-cd-escape');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);

    await expect(
      runInit({
        cwd: repo,
        home: fakeHome,
        contentDir: '..',
      }),
    ).rejects.toBeInstanceOf(ContentDirError);
    expect(existsSync(join(repo, OK_DIR))).toBe(false);
  });

  it('--content-dir on re-init is ignored (config.yml already exists) and warns', async () => {
    const repo = join(fakeHome, 'repo-cd-reinit');
    const sub = join(repo, 'notes');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);

    await runInit({
      cwd: repo,
      home: fakeHome,
    });
    expect(loadConfig(repo).config.content.dir).toBe('.');

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      contentDir: '.',
    });
    expect(result.contentDir).toBeUndefined();
    expect(result.contentDirRequested).toBe('.');
    expect(result.contentScaffoldFailed).toBe(false);
    expect(loadConfig(repo).config.content.dir).toBe('.');
    const output = formatInitResult(result, result.projectRoot);
    expect(output).toContain('ignored');
    expect(
      buildInitJsonSummary(result, { contentDir: '.', contentFileCount: null }).contentDirApplied,
    ).toBe(false);
  });

  it('does not claim "config.yml already exists" when content scaffolding failed', async () => {
    const repo = join(fakeHome, 'repo-scaffold-fail');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);
    const base = await runInit({
      cwd: repo,
      home: fakeHome,
    });

    const scaffoldFailed = {
      ...base,
      contentDirRequested: 'notes',
      contentDir: undefined,
      contentScaffoldFailed: true,
    };
    expect(formatInitResult(scaffoldFailed, base.projectRoot)).not.toContain('ignored');

    const configExisted = {
      ...base,
      contentDirRequested: 'notes',
      contentDir: undefined,
      contentScaffoldFailed: false,
    };
    expect(formatInitResult(configExisted, base.projectRoot)).toContain('ignored');
  });

  it('buildInitJsonSummary projects a promoted, narrowed result into stable JSON fields', async () => {
    const repo = join(fakeHome, 'repo-json');
    const sub = join(repo, 'notes');
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);

    const result = await runInit({
      cwd: sub,
      home: fakeHome,
      contentDir: '.',
    });

    const summary = buildInitJsonSummary(result, { contentDir: 'notes', contentFileCount: 3 });
    expect(summary.projectRoot).toBe(repo);
    expect(summary.gitRootPromoted).toBe(true);
    expect(summary.promotedFromDir).toBe('notes');
    expect(summary.contentDir).toBe('notes');
    expect(summary.contentDirRequested).toBe('.');
    expect(summary.contentDirApplied).toBe(true);
    expect(summary.contentFileCount).toBe(3);
    expect(summary.previewError).toBeNull();
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('buildInitJsonSummary surfaces previewError so a null count is unambiguous', async () => {
    const repo = join(fakeHome, 'repo-json-previewerr');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);
    const base = await runInit({
      cwd: repo,
      home: fakeHome,
    });
    const withPreviewError = { ...base, previewWarning: 'cannot access content directory' };
    const summary = buildInitJsonSummary(withPreviewError, {
      contentDir: '.',
      contentFileCount: null,
    });
    expect(summary.contentFileCount).toBeNull();
    expect(summary.previewError).toBe('cannot access content directory');
  });

  it('buildInitJsonSummary uses null for absent promotion / request / count', async () => {
    const repo = join(fakeHome, 'repo-json-flat');
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync({ cmd: ['git', 'init', '-q', repo], stdout: 'ignore', stderr: 'ignore' });
    configureTestGitRepository(repo);

    const result = await runInit({
      cwd: repo,
      home: fakeHome,
    });

    const summary = buildInitJsonSummary(result, { contentDir: '.', contentFileCount: null });
    expect(summary.gitRootPromoted).toBe(false);
    expect(summary.promotedFromDir).toBeNull();
    expect(summary.contentDirRequested).toBeNull();
    expect(summary.contentDirApplied).toBe(true);
    expect(summary.contentFileCount).toBeNull();
  });
});

describe('runInit — refuses the home directory as a project root', () => {
  let testDir: string;
  let fakeHome: string;
  const originalHome = process.env.HOME;
  const originalPlatform = process.platform;

  beforeEach(() => {
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'init-home-refusal-test-')));
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    process.env.HOME = fakeHome;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  const runAtHome = (cwd: string) =>
    runInit({
      cwd,
      home: fakeHome,
      scope: 'project',
    });

  it('throws HomeProjectRootError instead of setting up a project', async () => {
    await expect(runAtHome(fakeHome)).rejects.toBeInstanceOf(HomeProjectRootError);
  });

  it('writes nothing at all — no git repo, no .ok/, no project skills', async () => {
    await expect(runAtHome(fakeHome)).rejects.toThrow();

    expect(existsSync(join(fakeHome, '.git'))).toBe(false);
    expect(existsSync(join(fakeHome, OK_DIR))).toBe(false);
    expect(existsSync(join(fakeHome, '.okignore'))).toBe(false);
    for (const hostDir of ['.claude', '.cursor', '.codex']) {
      expect(existsSync(join(fakeHome, hostDir, 'skills', 'open-knowledge'))).toBe(false);
    }
    expect(existsSync(join(fakeHome, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(join(fakeHome, '.codex', 'config.toml'))).toBe(false);
  });

  it('refuses a symlinked spelling of home too', async () => {
    const linkedHome = join(testDir, 'home-link');
    symlinkSync(fakeHome, linkedHome);

    await expect(runAtHome(linkedHome)).rejects.toBeInstanceOf(HomeProjectRootError);
    expect(existsSync(join(fakeHome, '.git'))).toBe(false);
  });

  it('the command action prints the refusal and exits 64 rather than throwing', async () => {
    const savedCwd = process.cwd();
    const savedExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.chdir(fakeHome);

      await initCommand().parseAsync([], { from: 'user' });

      expect(process.exitCode).toBe(64);
      const printed = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(printed).toContain('Refusing to set up a GitQuire project in your home directory');
      expect(printed).not.toContain('at runInit');
    } finally {
      process.chdir(savedCwd);
      process.exitCode = savedExitCode;
      stderrSpy.mockRestore();
    }
  });

  it('still initializes a folder inside home', async () => {
    const project = join(fakeHome, 'notes');
    mkdirSync(project, { recursive: true });

    const result = await runInit({
      cwd: project,
      home: fakeHome,
    });

    expect(result.projectRoot).toBe(project);
    expect(existsSync(join(project, OK_DIR, 'config.yml'))).toBe(true);
  });
});

describe('resolveRequestedContentDir', () => {
  let root: string;
  beforeEach(() => {
    const raw = join(tmpdir(), `rrcd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    root = realpathSync(raw);
    mkdirSync(join(root, 'sub'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns "." when the request resolves to the project root itself', () => {
    expect(resolveRequestedContentDir('.', root, root)).toBe('.');
  });

  it('returns the git-root-relative path for a descendant (cwd-relative input)', () => {
    expect(resolveRequestedContentDir('sub', root, root)).toBe('sub');
    expect(resolveRequestedContentDir('.', root, join(root, 'sub'))).toBe('sub');
  });

  it('throws when the resolved path escapes the project root', () => {
    expect(() => resolveRequestedContentDir('..', root, root)).toThrow(ContentDirError);
  });

  it('throws when the path does not exist', () => {
    expect(() => resolveRequestedContentDir('nope', root, root)).toThrow(ContentDirError);
  });

  it('throws when the path is a file, not a directory', () => {
    writeFileSync(join(root, 'file.md'), '# x');
    expect(() => resolveRequestedContentDir('file.md', root, root)).toThrow(ContentDirError);
  });

  it('reports a non-ENOENT stat error as "not accessible", not "does not exist"', () => {
    writeFileSync(join(root, 'file.md'), '# x');
    let msg = '';
    try {
      resolveRequestedContentDir('file.md/nested', root, root);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('not accessible');
    expect(msg).not.toContain('does not exist');
  });

  it('resolves . when cwd reaches the project via a symlinked prefix', () => {
    const linkParent = join(
      tmpdir(),
      `rrcd-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    symlinkSync(root, linkParent);
    try {
      expect(resolveRequestedContentDir('.', root, linkParent)).toBe('.');
      expect(resolveRequestedContentDir('sub', root, linkParent)).toBe('sub');
    } finally {
      unlinkSync(linkParent);
    }
  });
});

describe('runInit — sharing mode', () => {
  let testDir: string;
  let fakeHome: string;
  const originalHome = process.env.HOME;
  const runInitForTest = async (
    options: Parameters<typeof runInit>[0] = {},
  ): Promise<Awaited<ReturnType<typeof runInit>>> =>
    runInit({
      cwd: testDir,
      home: fakeHome,
      isTTY: false,
      ...options,
    });

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `init-sharing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    fakeHome = join(testDir, 'fakehome');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('AC1: fresh `ok init --local-only` writes the OK artifact set to .git/info/exclude', async () => {
    const result = await runInitForTest({ sharing: 'local-only' });
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('local-only');
    expect(result.sharing.appended.length).toBeGreaterThan(0);
    const exclude = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.ok/');
    expect(exclude).toContain('.okignore');
  });

  it('AC3: --local-only in a non-git dir surfaces a no-exclude/no-git outcome (applySharingMode unit)', async () => {
    const nonGit = resolve(
      tmpdir(),
      `init-sharing-nongit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(nonGit, { recursive: true });
    try {
      const result = await applySharingMode({
        projectRoot: nonGit,
        desiredMode: 'local-only',
        explicitFlag: 'local-only',
      });
      expect(result).toEqual({
        kind: 'no-exclude',
        reason: 'no-git',
        localOnlyRequested: true,
      });
      expect(existsSync(join(nonGit, '.git'))).toBe(false);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('formatSharingOutcome reports a drain that rode along with appends', () => {
    const out = formatSharingOutcome(
      {
        kind: 'applied',
        mode: 'local-only',
        action: 'added',
        appended: ['.ok/', '.okignore'],
        alreadyPresent: ['.ok/'],
        removed: ['.claude/skills/trip-log/'],
      },
      '/tmp/project',
    ).join('\n');
    expect(out).toMatch(/appended 2 path\(s\)/);
    expect(out).toMatch(/\.claude\/skills\/trip-log\//);
    expect(out).toMatch(/stale entry/);
    expect(out).not.toMatch(/nothing to do/);
  });

  it('formatSharingOutcome reports a drain-only pass without claiming a no-op', () => {
    const out = formatSharingOutcome(
      {
        kind: 'applied',
        mode: 'local-only',
        action: 'cleaned',
        appended: [],
        alreadyPresent: ['.ok/', '.okignore'],
        removed: ['.claude/skills/trip-log/'],
      },
      '/tmp/project',
    ).join('\n');
    expect(out).toMatch(/cleared 1 stale entry/);
    expect(out).not.toMatch(/nothing to do/);
  });

  it('formatSharingOutcome renders the explicit --local-only-without-git warning', () => {
    const lines = formatSharingOutcome(
      { kind: 'no-exclude', reason: 'no-git', localOnlyRequested: true },
      '/tmp/proj',
    );
    const text = lines.join('\n');
    expect(text).toMatch(/--local-only requested but no git repo/);
    expect(text).toMatch(/git init/);
    expect(text).toMatch(/ok config-sharing unshare/);
  });

  it('formatSharingOutcome is silent on no-git when no explicit flag was set', () => {
    const lines = formatSharingOutcome(
      { kind: 'no-exclude', reason: 'no-git', localOnlyRequested: false },
      '/tmp/proj',
    );
    expect(lines).toEqual([]);
  });

  it('`ok init` (no flag, non-TTY) on a fresh repo defaults to local-only, matching the desktop dialogs', async () => {
    const result = await runInitForTest();
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('local-only');
    const exclude = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.ok/');
    expect(exclude).toContain('.okignore');
  });

  it('re-running `ok init` (no flag) on an initialized shared repo stays shared', async () => {
    await runInitForTest({ sharing: 'shared' });
    const result = await runInitForTest();
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('shared');
    const exclude = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).not.toContain('.mcp.json');
  });

  it('FR5 / D12: re-running `ok init` (no flag) on a local-only repo preserves the prior posture', async () => {
    await runInitForTest({ sharing: 'local-only' });
    const result = await runInitForTest();
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.mode).toBe('local-only');
  });

  it('AC11: a second `--local-only` is a no-op against the exclude file (alreadyPresent)', async () => {
    await runInitForTest({ sharing: 'local-only' });
    const before = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    const result = await runInitForTest({ sharing: 'local-only' });
    const after = readFileSync(join(testDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(after).toBe(before);
    expect(result.sharing.kind).toBe('applied');
    if (result.sharing.kind !== 'applied') throw new Error('expected applied');
    expect(result.sharing.action).toBe('noop');
    expect(result.sharing.alreadyPresent.length).toBeGreaterThan(0);
  });

  it('an explicit `--shared` after a prior `--local-only` removes OK paths and leaves the rest byte-identical', async () => {
    await runInitForTest({ sharing: 'local-only' });
    const excludePath = join(testDir, '.git', 'info', 'exclude');
    const before = readFileSync(excludePath, 'utf-8');
    const augmented = `# user header\n${before}*.tmp\n`;
    writeFileSync(excludePath, augmented, 'utf-8');

    await runInitForTest({ sharing: 'shared' });
    const after = readFileSync(excludePath, 'utf-8');
    expect(after).toContain('# user header');
    expect(after).toContain('*.tmp');
    expect(after).not.toContain('.ok/');
    expect(after).not.toContain('.mcp.json');
  });

  it('`--local-only` refuses when a teammate has committed `.okignore`, init still exits 0', async () => {
    await runInitForTest({ sharing: 'shared' });
    writeFileSync(join(testDir, '.okignore'), 'drafts/\n', 'utf-8');
    execFileSync('git', ['add', '.okignore'], { cwd: testDir });
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-m', 'add mcp'], {
      cwd: testDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const result = await runInitForTest({ sharing: 'local-only' });
    expect(result.sharing.kind).toBe('refused-tracked');
    if (result.sharing.kind !== 'refused-tracked') throw new Error('expected refused-tracked');
    expect(result.sharing.tracked).toContain('.okignore');
    expect(result.sharing.remediation).toContain('git rm --cached -- .okignore');
    expect(existsSync(join(testDir, '.okignore'))).toBe(true);
  });

  it('TTY prompt fires only when no explicit flag is set', async () => {
    let promptedDefault: 'shared' | 'local-only' | null = null;
    await runInitForTest({
      sharing: 'shared',
      isTTY: true,
      sharingPromptFn: async (def) => {
        promptedDefault = def;
        return def;
      },
    });
    expect(promptedDefault).toBeNull();
  });

  it('TTY prompt receives `local-only` as the pre-selected default on a previously-local-only repo', async () => {
    await runInitForTest({ sharing: 'local-only' });
    let promptedDefault: 'shared' | 'local-only' | null = null;
    const result = await runInitForTest({
      isTTY: true,
      sharingPromptFn: async (def) => {
        promptedDefault = def;
        return def;
      },
    });
    expect(promptedDefault).toBe('local-only');
    expect(result.sharing.kind).toBe('applied');
  });
});

describe('resolveSharingMode', () => {
  let testDir: string;
  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `resolve-sharing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('explicit flag beats everything', async () => {
    const mode = await resolveSharingMode({
      sharing: 'local-only',
      projectRoot: testDir,
      isTTY: true,
      promptFn: async () => 'shared',
    });
    expect(mode).toBe('local-only');
  });

  it('non-TTY without flag on an already-initialized project → preserves shared', async () => {
    const mode = await resolveSharingMode({ projectRoot: testDir, isTTY: false });
    expect(mode).toBe('shared');
  });

  it('non-TTY without flag on a fresh project → local-only, matching the dialogs', async () => {
    const mode = await resolveSharingMode({
      projectRoot: testDir,
      isTTY: false,
      freshProject: true,
    });
    expect(mode).toBe('local-only');
  });

  it('TTY without flag → invokes prompt with the readSharingMode seed', async () => {
    let seed: 'shared' | 'local-only' | null = null;
    const mode = await resolveSharingMode({
      projectRoot: testDir,
      isTTY: true,
      promptFn: async (s) => {
        seed = s;
        return 'local-only';
      },
    });
    expect(seed).toBe('shared');
    expect(mode).toBe('local-only');
  });
});
