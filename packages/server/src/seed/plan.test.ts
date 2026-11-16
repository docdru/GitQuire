import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { planSeed } from './plan.ts';
import { STARTER_PACKS } from './starter.ts';
import { SeedPrerequisiteError, SeedRootDirError } from './types.ts';

const STARTER_FOLDERS = STARTER_PACKS['knowledge-base'].folders;

describe('planSeed — nested .gitquire/ era', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'seed-plan-'));
    mkdirSync(join(projectDir, '.gitquire'), { recursive: true });
    writeFileSync(join(projectDir, '.gitquire', 'config.yml'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('throws SeedPrerequisiteError when .gitquire/config.yml is absent', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'seed-bare-'));
    try {
      await expect(planSeed({ projectDir: bare })).rejects.toThrow(SeedPrerequisiteError);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('the missing-config error names the running channel init command', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'seed-bare-'));
    try {
      vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
      await expect(planSeed({ projectDir: bare })).rejects.toThrow(
        'Run `gq init` first to scaffold the tool config.',
      );
      vi.stubEnv('GITQUIRE_CHANNEL', 'beta');
      await expect(planSeed({ projectDir: bare })).rejects.toThrow(
        'Run `gq-beta init` first to scaffold the tool config.',
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('throws SeedPrerequisiteError when .gitquire/ exists but config.yml is absent', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'seed-sidecar-'));
    try {
      mkdirSync(join(bare, '.gitquire'), { recursive: true });
      writeFileSync(join(bare, '.gitquire', 'frontmatter.yml'), 'title: x\n', 'utf-8');
      await expect(planSeed({ projectDir: bare })).rejects.toThrow(SeedPrerequisiteError);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('skipPrerequisite bypasses the gate — previews an all-created plan in a bare dir', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'seed-preview-'));
    try {
      const plan = await planSeed({ projectDir: bare, skipPrerequisite: true });
      expect(plan.created.length).toBeGreaterThan(0);
      expect(plan.skipped.length).toBe(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('plans every starter folder + nested .gitquire/ + frontmatter.yml + templates/<name>.md', async () => {
    const plan = await planSeed({ projectDir });
    const createdPaths = new Set(plan.created.map((e) => e.path));

    for (const folder of STARTER_FOLDERS) {
      expect(createdPaths.has(folder.path)).toBe(true);
      expect(createdPaths.has(`${folder.path}/.gitquire`)).toBe(true);
      expect(createdPaths.has(`${folder.path}/.gitquire/frontmatter.yml`)).toBe(true);
      expect(createdPaths.has(`${folder.path}/.gitquire/templates`)).toBe(true);
      expect(
        createdPaths.has(`${folder.path}/.gitquire/templates/${folder.starterTemplate}.md`),
      ).toBe(true);
    }
    expect(createdPaths.has('log.md')).toBe(true);
  });

  test('plan has no configEdits field — folders[] write path retired (FR8 / D19)', async () => {
    const plan = await planSeed({ projectDir });
    expect((plan as unknown as Record<string, unknown>).configEdits).toBeUndefined();
  });

  test('frontmatter.yml + template entries carry their template id for apply()', async () => {
    const plan = await planSeed({ projectDir });
    for (const folder of STARTER_FOLDERS) {
      const fmEntry = plan.created.find(
        (e) => e.path === `${folder.path}/.gitquire/frontmatter.yml`,
      );
      expect(fmEntry?.template).toBe(`${folder.path}/.gitquire/frontmatter.yml`);

      const tplEntry = plan.created.find(
        (e) => e.path === `${folder.path}/.gitquire/templates/${folder.starterTemplate}.md`,
      );
      expect(tplEntry?.template).toBe(
        `${folder.path}/.gitquire/templates/${folder.starterTemplate}.md`,
      );
    }
  });

  test('skips entries that already exist on disk', async () => {
    mkdirSync(join(projectDir, 'external-sources', '.gitquire'), { recursive: true });
    writeFileSync(
      join(projectDir, 'external-sources', '.gitquire', 'frontmatter.yml'),
      'title: User had this already\n',
    );

    const plan = await planSeed({ projectDir });
    const skippedPaths = new Set(plan.skipped.map((e) => e.path));
    expect(skippedPaths.has('external-sources')).toBe(true);
    expect(skippedPaths.has('external-sources/.gitquire')).toBe(true);
    expect(skippedPaths.has('external-sources/.gitquire/frontmatter.yml')).toBe(true);

    const createdPaths = new Set(plan.created.map((e) => e.path));
    expect(createdPaths.has('research')).toBe(true);
    expect(createdPaths.has('articles')).toBe(true);
  });

  test('rootDir scopes the scaffold under a subfolder', async () => {
    const plan = await planSeed({ projectDir, rootDir: 'brain' });
    const createdPaths = new Set(plan.created.map((e) => e.path));

    expect(createdPaths.has('brain')).toBe(true);
    for (const folder of STARTER_FOLDERS) {
      expect(createdPaths.has(`brain/${folder.path}`)).toBe(true);
      expect(createdPaths.has(`brain/${folder.path}/.gitquire/frontmatter.yml`)).toBe(true);
      expect(
        createdPaths.has(`brain/${folder.path}/.gitquire/templates/${folder.starterTemplate}.md`),
      ).toBe(true);
    }
    expect(createdPaths.has('brain/log.md')).toBe(true);
  });

  test('rootDir rejects absolute paths', async () => {
    await expect(planSeed({ projectDir, rootDir: '/etc/evil' })).rejects.toThrow(SeedRootDirError);
  });

  test('rootDir rejects path traversal', async () => {
    await expect(planSeed({ projectDir, rootDir: '../escape' })).rejects.toThrow(SeedRootDirError);
  });
});

describe('planSeed — codebase-wiki nested paths', () => {
  let projectDir: string;
  const WIKI_PACK = STARTER_PACKS['codebase-wiki'];

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'seed-plan-wiki-'));
    mkdirSync(join(projectDir, '.gitquire'), { recursive: true });
    writeFileSync(join(projectDir, '.gitquire', 'config.yml'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('plans nested folder + .gitquire/frontmatter.yml + template entries with slash-bearing template ids', async () => {
    const plan = await planSeed({ projectDir, packId: 'codebase-wiki' });
    const byPath = new Map(plan.created.map((e) => [e.path, e]));

    for (const folder of WIKI_PACK.folders) {
      expect(byPath.has(folder.path)).toBe(true);
      expect(byPath.get(`${folder.path}/.gitquire/frontmatter.yml`)?.template).toBe(
        `${folder.path}/.gitquire/frontmatter.yml`,
      );
      expect(
        byPath.get(`${folder.path}/.gitquire/templates/${folder.starterTemplate}.md`)?.template,
      ).toBe(`${folder.path}/.gitquire/templates/${folder.starterTemplate}.md`);
    }
  });

  test('plans wiki/-prefixed rootFiles at their nested paths', async () => {
    const plan = await planSeed({ projectDir, packId: 'codebase-wiki' });
    const createdPaths = new Set(plan.created.map((e) => e.path));
    expect(createdPaths.has('wiki/OVERVIEW.md')).toBe(true);
    expect(createdPaths.has('wiki/log.md')).toBe(true);
  });
});
