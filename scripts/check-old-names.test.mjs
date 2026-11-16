import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { compareWithBaseline, countOldNames, scanTree } from './check-old-names.mjs';

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('counts each kind of old name', () => {
  expect(
    countOldNames(
      "import x from '@inkeep/open-knowledge-core';\nRun `ok start` in .ok/config.yml with OK_BIND and --ok-bg, see ok-rules.\n",
    ),
  ).toEqual({
    'inkeep-scope': 1,
    'open-knowledge': 1,
    'ok-command': 1,
    'ok-folder': 1,
    'ok-env': 1,
    'ok-style-token': 1,
    'ok-rules': 1,
  });
});

test('does not count the new names or ordinary words', () => {
  expect(
    countOldNames(
      "import x from '@gitquire/core';\nRun `gq start` in .gitquire/config.yml with GITQUIRE_BIND; result.ok is fine, it's ok to start; .okignore\n",
    ),
  ).toEqual({});
});

test('reports only files whose count grew past the baseline', () => {
  const current = { 'a.ts': { 'ok-env': 2 }, 'b.ts': { 'ok-folder': 1 }, 'c.ts': { 'ok-env': 1 } };
  const baseline = { 'a.ts': { 'ok-env': 2 }, 'b.ts': { 'ok-folder': 3 } };
  expect(compareWithBaseline(current, baseline)).toEqual([
    { file: 'c.ts', id: 'ok-env', count: 1, allowed: 0 },
  ]);
});

test('skips the always-allowed files and binaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gq-old-names-'));
  dirs.push(root);
  fs.writeFileSync(path.join(root, 'README.md'), 'GitQuire started as a fork of OpenKnowledge.\n');
  fs.writeFileSync(path.join(root, 'logo.png'), 'OpenKnowledge');
  fs.writeFileSync(path.join(root, 'new.ts'), "const dir = '.ok/local';\n");
  expect(scanTree(root, ['README.md', 'logo.png', 'new.ts'])).toEqual({
    'new.ts': { 'ok-folder': 1 },
  });
});
