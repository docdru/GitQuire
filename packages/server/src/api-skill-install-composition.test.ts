import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstallSkillSuccessSchema, SkillInstallSuccessSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';

const isolated = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => isolated.home,
}));
let root: string;
let server: BootedServer;
beforeAll(async () => {
  isolated.home = mkdtempSync(join(tmpdir(), 'ok-install-home-'));
  root = mkdtempSync(join(tmpdir(), 'ok-install-contract-'));
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(root, '.cursor'));
  server = await bootCompositionRig(root, { configHomedirOverride: isolated.home });
  await server.ready;
}, 60_000);
afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
  rmSync(isolated.home, { recursive: true, force: true });
});
async function post(path: string, body: object) {
  return rawRequest(server.port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'install-contract' },
    body: JSON.stringify(body),
  });
}

const markdown = (name: string) =>
  `---\nname: ${name}\ndescription: Install contract\n---\n\nLiteral \\* and <custom>raw</custom>.  \n`;
function seed(name: string) {
  const dir = join(root, '.claude/skills', name);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown(name));
  writeFileSync(join(dir, 'assets/data.bin'), Buffer.from([0, 255, 10]));
  return dir;
}

test('catalog installation projects exact bytes and preserves placement, conversion and source outcomes', async () => {
  const name = 'catalog-contract';
  seed(name);
  const install = async (extra: object) => {
    const response = await post('/api/skill/install', { scope: 'project', name, ...extra });
    expect(response.status, response.body).toBe(200);
    return SkillInstallSuccessSchema.parse(JSON.parse(response.body));
  };
  const result = await install({ targets: ['claude', 'cursor'], mode: 'copy' });
  expect(result.hosts).toContain('cursor');
  expect(InstallSkillSuccessSchema.safeParse(result).success).toBe(false);
  expect(readFileSync(join(root, '.cursor/skills', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
  expect(readFileSync(join(root, '.cursor/skills', name, 'assets/data.bin'))).toEqual(
    Buffer.from([0, 255, 10]),
  );
  await install({ convert: { target: 'cursor', mode: 'link' } });
  expect(lstatSync(join(root, '.cursor/skills', name)).isSymbolicLink()).toBe(true);
  expect(await install({ place: { dir: 'bundles', mode: 'copy' } })).toMatchObject({
    placedAt: `bundles/${name}`,
  });
  expect(readFileSync(join(root, 'bundles', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
  await install({ unplace: { path: `bundles/${name}` } });
  expect(existsSync(join(root, 'bundles', name))).toBe(false);
  expect(await install({ source: 'cursor' })).toMatchObject({
    sourceMovedTo: `.cursor/skills/${name}`,
  });
  expect(readFileSync(join(root, '.cursor/skills', name, 'SKILL.md'), 'utf8')).toBe(markdown(name));
});

test('install contracts reject invalid source and conflicting operations independently', async () => {
  const name = 'negative-contract';
  seed(name);
  for (const [path, body, status, detail] of [
    ['/api/skill/install', { noOpen: true }, 400, undefined],
    ['/api/skill/install', { scope: 'project', name: 'missing' }, 404, undefined],
    [
      '/api/skill/install',
      { scope: 'project', name, place: { dir: '../escape', mode: 'copy' } },
      400,
      'PLACE_PATH_INVALID',
    ],
    ['/api/skill/install', { scope: 'project', name, remove: ['claude'] }, 400, 'REMOVE_SOURCE'],
    [
      '/api/skill/install',
      { scope: 'project', name, convert: { target: 'cursor', mode: 'link' } },
      404,
      'cursor',
    ],
  ] as const) {
    const result = await post(path, body);
    expect(result.status, result.body).toBe(status);
    expect(result.headers['content-type']).toContain('application/problem+json');
    expect(result.headers['x-request-id']).toBe('install-contract');
    if (detail !== undefined) expect(JSON.parse(result.body).detail).toBe(detail);
  }
});

test.each(['convert', 'unplace'] as const)(
  '%s preserves an untouched copy after a source edit and reports divergence without assigning blame',
  async (operation) => {
    const name = `source-edit-${operation}`;
    const source = join(seed(name), 'SKILL.md');
    const copyDir = join(root, 'qa048/bundles', name);
    const placement = await post('/api/skill/install', {
      scope: 'project',
      name,
      place: { dir: 'qa048/bundles', mode: 'copy' },
    });
    expect(placement.status, placement.body).toBe(200);
    const originalCopy = readFileSync(join(copyDir, 'SKILL.md'));
    const editedSource = `${markdown(name)}\nSource-only change.\n`;
    writeFileSync(source, editedSource);
    const response = await post('/api/skill/install', {
      scope: 'project',
      name,
      ...(operation === 'convert'
        ? { convert: { target: 'qa048/bundles', mode: 'link' } }
        : { unplace: { path: `qa048/bundles/${name}` } }),
    });
    expect(response.status, response.body).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      type: 'urn:ok:error:doc-already-exists',
      title:
        operation === 'convert'
          ? 'This copy differs from the current source and was preserved. Inspect both versions before replacing or converting it.'
          : 'This copy differs from the current source and was preserved. Inspect both versions before removing it.',
      detail: operation === 'convert' ? 'qa048/bundles' : `qa048/bundles/${name}`,
    });
    expect(readFileSync(join(copyDir, 'SKILL.md'))).toEqual(originalCopy);
    expect(readFileSync(source, 'utf8')).toBe(editedSource);
    expect(lstatSync(copyDir).isSymbolicLink()).toBe(false);
  },
);

test('custom-root removal preserves an untouched copy after a source edit and reports divergence without assigning blame', async () => {
  const name = 'source-edit-custom-remove';
  const source = join(seed(name), 'SKILL.md');
  const copy = join(root, 'qa048/skills', name, 'SKILL.md');
  const placement = await post('/api/skill/install', {
    scope: 'project',
    name,
    place: { dir: 'qa048/skills', mode: 'copy' },
  });
  expect(placement.status, placement.body).toBe(200);
  const originalCopy = readFileSync(copy);
  const editedSource = `${markdown(name)}\nSource-only change.\n`;
  writeFileSync(source, editedSource);
  const response = await post('/api/skill/install', {
    scope: 'project',
    name,
    remove: ['qa048/skills'],
  });
  expect(response.status, response.body).toBe(200);
  expect(SkillInstallSuccessSchema.parse(JSON.parse(response.body))).toMatchObject({
    warnings: [
      `The copy at qa048/skills/${name} differs from the current source and was preserved. Inspect both versions before removing it.`,
    ],
    warningCodes: ['place-fork-refused'],
  });
  expect(readFileSync(copy)).toEqual(originalCopy);
  expect(readFileSync(source, 'utf8')).toBe(editedSource);
});
