import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OK_DIR } from '@gitquire/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import {
  addOkPathsToGitExclude,
  formatTrackedRemediation,
  getOkArtifactPaths,
  probeTrackedOkPaths,
  readSharingMode,
  removeOkPathsFromGitExclude,
} from './git-exclude.ts';

function uniqueDir(prefix: string): string {
  return resolve(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  configureTestGitRepository(dir);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

function writeExclude(projectRoot: string, content: string): string {
  const path = join(projectRoot, '.git', 'info', 'exclude');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function readExclude(projectRoot: string): string {
  return readFileSync(join(projectRoot, '.git', 'info', 'exclude'), 'utf-8');
}

describe('getOkArtifactPaths', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('artifact-paths-test');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns `.gitquire/` and `.okignore` when no config.yml exists', () => {
    expect(getOkArtifactPaths(dir)).toEqual([`${OK_DIR}/`, '.okignore']);
  });

  it('preserves a stable order so `gq config-sharing status` and unit-test snapshots are deterministic', () => {
    const a = getOkArtifactPaths(dir);
    const b = getOkArtifactPaths(dir);
    expect([...a]).toEqual([...b]);
  });

  it('emits unanchored `.gitquire/` / `.okignore` regardless of content.dir', () => {
    mkdirSync(join(dir, OK_DIR), { recursive: true });
    writeFileSync(join(dir, OK_DIR, 'config.yml'), 'content:\n  dir: docs\n', 'utf-8');
    const paths = getOkArtifactPaths(dir);
    expect(paths).toEqual(['.gitquire/', '.okignore']);
  });
});

describe('root + nested .gitquire coverage for a non-default content.dir', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('nested-exclude-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function isIgnored(rel: string): boolean {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel], {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  }

  it('excludes the ROOT `.gitquire/` config dir AND folder-nested `.gitquire/` / `.okignore` (content.dir = docs)', () => {
    mkdirSync(join(dir, OK_DIR), { recursive: true });
    writeFileSync(join(dir, OK_DIR, 'config.yml'), 'content:\n  dir: docs\n', 'utf-8');
    writeFileSync(join(dir, '.okignore'), '', 'utf-8');
    mkdirSync(join(dir, 'docs', 'guides', '.gitquire'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'guides', '.gitquire', 'frontmatter.yml'), '', 'utf-8');
    writeFileSync(join(dir, 'docs', 'guides', '.okignore'), '', 'utf-8');

    const result = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('updated');

    expect(isIgnored('.gitquire/config.yml')).toBe(true);
    expect(isIgnored('.okignore')).toBe(true);
    expect(isIgnored('docs/guides/.gitquire/frontmatter.yml')).toBe(true);
    expect(isIgnored('docs/guides/.okignore')).toBe(true);
  });
});

describe('addOkPathsToGitExclude', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('add-exclude-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends fresh paths to a default exclude template', () => {
    const template = `# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
`;
    writeExclude(dir, template);

    const result = addOkPathsToGitExclude(dir, ['.gitquire/', '.mcp.json']);

    expect(result).toEqual({
      kind: 'updated',
      appended: ['.gitquire/', '.mcp.json'],
      alreadyPresent: [],
      removed: [],
    });
    const after = readExclude(dir);
    expect(after.startsWith(template)).toBe(true);
    expect(after).toMatch(/\.gitquire\/\n/);
    expect(after).toMatch(/\.mcp\.json\n/);
  });

  it('inserts a newline before appending when existing content has no trailing newline', () => {
    writeExclude(dir, '*.tmp');
    const result = addOkPathsToGitExclude(dir, ['.gitquire/']);
    expect(result.kind).toBe('updated');
    expect(readExclude(dir)).toBe('*.tmp\n.gitquire/\n');
  });

  it('is idempotent — running twice classifies as alreadyPresent', () => {
    writeExclude(dir, '');
    addOkPathsToGitExclude(dir, ['.gitquire/']);
    const second = addOkPathsToGitExclude(dir, ['.gitquire/']);
    expect(second).toEqual({
      kind: 'updated',
      appended: [],
      alreadyPresent: ['.gitquire/'],
      removed: [],
    });
    expect(readExclude(dir)).toBe('.gitquire/\n');
  });

  it('recognizes all four idempotence variants — `.gitquire`, `.gitquire/`, `/.gitquire`, `/.gitquire/`', () => {
    for (const variant of ['.gitquire', '.gitquire/', '/.gitquire', '/.gitquire/']) {
      writeExclude(dir, `${variant}\n`);
      const result = addOkPathsToGitExclude(dir, ['.gitquire/']);
      expect(result).toEqual({
        kind: 'updated',
        appended: [],
        alreadyPresent: ['.gitquire/'],
        removed: [],
      });
    }
  });

  it('overlaps cleanly with the clone-precedent `.gitquire/` line', () => {
    writeExclude(dir, '.gitquire/\n');
    const result = addOkPathsToGitExclude(dir, [
      '.gitquire/',
      '.mcp.json',
      '.claude/skills/open-knowledge/',
    ]);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.alreadyPresent).toEqual(['.gitquire/']);
    expect(result.appended).toEqual(['.mcp.json', '.claude/skills/open-knowledge/']);
    expect(readExclude(dir)).toBe('.gitquire/\n.mcp.json\n.claude/skills/open-knowledge/\n');
  });

  it('refuses when a candidate path is tracked upstream and does not write', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    writeExclude(dir, '');
    const result = addOkPathsToGitExclude(dir, ['.gitquire/', '.mcp.json']);
    expect(result.kind).toBe('refused-tracked');
    if (result.kind !== 'refused-tracked') throw new Error('unreachable');
    expect(result.tracked).toEqual(['.mcp.json']);
    expect(result.remediation).toContain('Cannot switch GitQuire to local-only');
    expect(result.remediation).toContain('git rm --cached -- .mcp.json');
    expect(readExclude(dir)).toBe('');
  });

  it('proceeds normally after the user runs `git rm --cached` on the tracked path', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    execFileSync('git', ['add', '.mcp.json'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'add mcp'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['rm', '--cached', '.mcp.json'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    writeExclude(dir, '');
    const result = addOkPathsToGitExclude(dir, ['.gitquire/', '.mcp.json']);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.appended.sort()).toEqual(['.gitquire/', '.mcp.json']);
  });

  it('returns no-exclude / no-git for non-git directories', () => {
    const nonGit = uniqueDir('non-git');
    mkdirSync(nonGit, { recursive: true });
    try {
      const result = addOkPathsToGitExclude(nonGit, ['.gitquire/']);
      expect(result).toEqual({ kind: 'no-exclude', reason: 'no-git' });
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('returns no-exclude / no-info-dir when the gitdir has no info/ subdir', () => {
    const noInfo = uniqueDir('no-info');
    initGitRepo(noInfo);
    try {
      rmSync(join(noInfo, '.git', 'info'), { recursive: true, force: true });
      const result = addOkPathsToGitExclude(noInfo, ['.gitquire/']);
      expect(result).toEqual({ kind: 'no-exclude', reason: 'no-info-dir' });
    } finally {
      rmSync(noInfo, { recursive: true, force: true });
    }
  });

  it('writes to the linked worktree common dir, not <projectRoot>/.git/info/exclude', () => {
    const mainRepo = uniqueDir('main-repo');
    const linkedWorktree = uniqueDir('linked-worktree');
    initGitRepo(mainRepo);
    writeFileSync(join(mainRepo, 'README.md'), '# main\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: mainRepo });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: mainRepo,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['worktree', 'add', '-b', 'feature', linkedWorktree], {
      cwd: mainRepo,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    configureTestGitRepository(linkedWorktree);
    try {
      const dotGitContent = readFileSync(join(linkedWorktree, '.git'), 'utf-8');
      expect(dotGitContent.startsWith('gitdir:')).toBe(true);

      const result = addOkPathsToGitExclude(linkedWorktree, ['.gitquire/', '.mcp.json']);
      expect(result.kind).toBe('updated');

      const mainExclude = join(mainRepo, '.git', 'info', 'exclude');
      expect(existsSync(mainExclude)).toBe(true);
      const mainExcludeContent = readFileSync(mainExclude, 'utf-8');
      expect(mainExcludeContent).toContain('.gitquire/');
      expect(mainExcludeContent).toContain('.mcp.json');

      expect(existsSync(join(linkedWorktree, '.git', 'info', 'exclude'))).toBe(false);
    } finally {
      rmSync(linkedWorktree, { recursive: true, force: true });
      rmSync(mainRepo, { recursive: true, force: true });
    }
  });
});

describe('removeOkPathsFromGitExclude', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('remove-exclude-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes matching lines and preserves every other line byte-identical', () => {
    const original = `# user header
*.tmp
.gitquire/
.mcp.json
build/
.DS_Store
`;
    writeExclude(dir, original);
    removeOkPathsFromGitExclude(dir, ['.gitquire/', '.mcp.json']);
    const expected = `# user header
*.tmp
build/
.DS_Store
`;
    expect(readExclude(dir)).toBe(expected);
  });

  it('matches every variant on remove — `.gitquire`, `.gitquire/`, `/.gitquire`, `/.gitquire/`', () => {
    for (const variant of ['.gitquire', '.gitquire/', '/.gitquire', '/.gitquire/']) {
      writeExclude(dir, `*.tmp\n${variant}\nbuild/\n`);
      removeOkPathsFromGitExclude(dir, ['.gitquire/']);
      expect(readExclude(dir)).toBe('*.tmp\nbuild/\n');
    }
  });

  it('is a no-op when no OK paths are present', () => {
    const original = '*.tmp\nbuild/\n';
    writeExclude(dir, original);
    removeOkPathsFromGitExclude(dir, ['.gitquire/']);
    expect(readExclude(dir)).toBe(original);
  });

  it('survives a round-trip — `add` then `remove` reproduces the pre-add bytes', () => {
    const original = '# user header\n*.tmp\n';
    writeExclude(dir, original);
    addOkPathsToGitExclude(dir, ['.gitquire/', '.mcp.json']);
    removeOkPathsFromGitExclude(dir, ['.gitquire/', '.mcp.json']);
    expect(readExclude(dir)).toBe(original);
  });

  it('is tolerant of an absent exclude file', () => {
    rmSync(join(dir, '.git', 'info', 'exclude'), { force: true });
    const result = removeOkPathsFromGitExclude(dir, ['.gitquire/']);
    expect(result.kind).toBe('updated');
  });

  it.skipIf(process.platform === 'win32')(
    'reports an unreadable linked-worktree common-dir pointer as inaccessible',
    () => {
      rmSync(join(dir, '.git'), { recursive: true });
      const gitDir = join(dir, '.git-state');
      mkdirSync(gitDir);
      writeFileSync(join(dir, '.git'), `gitdir: ${gitDir}\n`);
      symlinkSync('commondir', join(gitDir, 'commondir'));

      expect(removeOkPathsFromGitExclude(dir, ['.gitquire/'])).toEqual({
        kind: 'no-exclude',
        reason: 'inaccessible',
      });
    },
  );

  it('reports the actually-removed artifact paths in `removed` (not the full candidate list)', () => {
    writeExclude(dir, '# header\n.gitquire/\n.mcp.json\nbuild/\n');
    const result = removeOkPathsFromGitExclude(dir, [
      '.gitquire/',
      '.mcp.json',
      '.cursor/mcp.json',
    ]);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.removed.sort()).toEqual(['.gitquire/', '.mcp.json']);
  });

  it('reports an empty `removed` when no candidate line was present', () => {
    writeExclude(dir, '*.tmp\nbuild/\n');
    const result = removeOkPathsFromGitExclude(dir, ['.gitquire/']);
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('unreachable');
    expect(result.removed).toEqual([]);
  });
});

describe('readSharingMode', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('read-mode-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns `shared` for a fresh repo with no excluded OK paths', () => {
    writeExclude(dir, '');
    expect(readSharingMode(dir)).toBe('shared');
  });

  it('returns `local-only` when EVEN ONE OK artifact path is excluded (OR-of-variants, not AND)', () => {
    writeExclude(dir, '.okignore\n');
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('returns `local-only` when EVERY OK artifact path is excluded', () => {
    const paths = getOkArtifactPaths(dir);
    writeExclude(dir, `${paths.join('\n')}\n`);
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('returns `shared` when the exclude file is missing', () => {
    rmSync(join(dir, '.git', 'info', 'exclude'), { force: true });
    expect(readSharingMode(dir)).toBe('shared');
  });

  it('returns `no-git` for a non-git directory', () => {
    const nonGit = uniqueDir('non-git-read-mode');
    mkdirSync(nonGit, { recursive: true });
    try {
      expect(readSharingMode(nonGit)).toBe('no-git');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('ignores unrelated user lines', () => {
    writeExclude(dir, '*.tmp\n.DS_Store\nbuild/\n');
    expect(readSharingMode(dir)).toBe('shared');
  });
});

describe('probeTrackedOkPaths', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('probe-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the tracked subset, skipping paths absent on disk', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    mkdirSync(join(dir, '.claude', 'skills', 'open-knowledge'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'), 'x', 'utf-8');
    execFileSync('git', ['add', '.mcp.json', '.claude/skills/open-knowledge/SKILL.md'], {
      cwd: dir,
    });
    execFileSync('git', ['commit', '-m', 'add'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const result = probeTrackedOkPaths(dir, [
      '.mcp.json',
      '.cursor/mcp.json',
      '.claude/skills/open-knowledge/',
    ]);
    expect(result.tracked.sort()).toEqual(['.claude/skills/open-knowledge/', '.mcp.json']);
  });

  it('returns an empty list when no candidate is tracked', () => {
    writeFileSync(join(dir, '.mcp.json'), '{}', 'utf-8');
    expect(probeTrackedOkPaths(dir, ['.mcp.json']).tracked).toEqual([]);
  });

  it('returns an empty list when the directory has no candidate on disk', () => {
    expect(probeTrackedOkPaths(dir, ['.mcp.json']).tracked).toEqual([]);
  });
});

function quoteForPlatform(value: string): string {
  return process.platform === 'win32' ? `"${value}"` : `'${value}'`;
}

describe('formatTrackedRemediation', () => {
  it('lists tracked paths and emits a `git rm --cached` for each — `-r` for dirs', () => {
    const out = formatTrackedRemediation(['.mcp.json', '.claude/skills/open-knowledge/']);
    expect(out).toContain('  .mcp.json');
    expect(out).toContain('  .claude/skills/open-knowledge/');
    expect(out).toContain('git rm --cached -- .mcp.json');
    expect(out).toContain('git rm --cached -r -- .claude/skills/open-knowledge');
  });

  it('leaves a shell- and pathspec-safe name bare, so the line pastes into any shell', () => {
    const out = formatTrackedRemediation(['.mcp.json']);
    const commandLine = out.split('\n').find((l) => l.includes('git rm --cached'));
    expect(commandLine?.trim()).toBe('git rm --cached -- .mcp.json');
  });

  it('converts and quotes a name git would read as a pattern', () => {
    const out = formatTrackedRemediation(['star*.md', ':colon.md', ':!bang.md']);
    for (const name of ['star*.md', ':colon.md', ':!bang.md']) {
      expect(out).toContain(`git rm --cached -- ${quoteForPlatform(`:(literal)${name}`)}`);
    }
  });

  it('warns about the teammate-side-effect of `git rm --cached`', () => {
    const out = formatTrackedRemediation(['.mcp.json']);
    expect(out).toContain('your teammates will see a deletion on their next pull');
  });
});

describe('shared -> local-only transition with tracked shareable .gitquire artifacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('tracked-artifact-transition-test');
    initGitRepo(dir);
    mkdirSync(join(dir, '.gitquire', 'schemas'), { recursive: true });
    mkdirSync(join(dir, '.gitquire', 'templates'), { recursive: true });
    writeFileSync(join(dir, '.gitquire', 'config.yml'), 'x: 1\n', 'utf-8');
    writeFileSync(join(dir, '.gitquire', 'schemas', 'lint.json'), '{}\n', 'utf-8');
    writeFileSync(join(dir, '.gitquire', 'templates', 'note.md'), '# t\n', 'utf-8');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function commitOkArtifacts(): void {
    execFileSync(
      'git',
      ['add', '.gitquire/config.yml', '.gitquire/schemas/lint.json', '.gitquire/templates/note.md'],
      { cwd: dir },
    );
    execFileSync('git', ['commit', '-m', 'share ok artifacts'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  }

  it('refuses via the tracked-paths probe and leaves the project shared (no silent exclude)', () => {
    commitOkArtifacts();
    writeExclude(dir, '');
    expect(readSharingMode(dir)).toBe('shared');

    const result = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('refused-tracked');
    if (result.kind !== 'refused-tracked') throw new Error('unreachable');
    expect(result.tracked).toEqual(['.gitquire/']);
    expect(result.remediation).toContain('git rm --cached -r -- .gitquire');
    expect(result.remediation).toContain('your teammates will see a deletion on their next pull');
    expect(readExclude(dir)).toBe('');
    expect(readSharingMode(dir)).toBe('shared');
  });

  it('proceeds when the artifacts exist on disk but are untracked', () => {
    writeExclude(dir, '');
    const result = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(result.kind).toBe('updated');
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('unblocks after the remediation command untracks the artifacts', () => {
    commitOkArtifacts();
    writeExclude(dir, '');
    const refused = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(refused.kind).toBe('refused-tracked');

    execFileSync('git', ['rm', '--cached', '-r', '.gitquire'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const retried = addOkPathsToGitExclude(dir, getOkArtifactPaths(dir));
    expect(retried.kind).toBe('updated');
    expect(readSharingMode(dir)).toBe('local-only');
    expect(existsSync(join(dir, '.gitquire', 'config.yml'))).toBe(true);
  });
});

describe('legacy skills carve-out spelling (recognition only)', () => {
  let dir: string;
  beforeEach(() => {
    dir = uniqueDir('skills-carve-test');
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readSharingMode reports local-only from the carve lines alone', () => {
    writeExclude(dir, '**/.gitquire/*\n!**/.gitquire/skills/\n');
    expect(readSharingMode(dir)).toBe('local-only');
  });

  it('removeOkPaths (share) strips the carve lines so nothing is left excluding .gitquire/', () => {
    writeExclude(dir, '**/.gitquire/*\n!**/.gitquire/skills/\n.okignore\n');
    removeOkPathsFromGitExclude(dir, getOkArtifactPaths(dir));
    const content = readExclude(dir);
    expect(content).not.toContain('**/.gitquire/*');
    expect(content).not.toContain('!**/.gitquire/skills/');
    expect(readSharingMode(dir)).toBe('shared');
  });
});
