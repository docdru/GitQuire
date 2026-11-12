import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { checkTarget, extractTargets, findBrokenLinks } from './check-docs-links.mjs';

let out;

function write(relative, content = '') {
  const file = path.join(out, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(() => {
  out = mkdtempSync(path.join(tmpdir(), 'docs-out-'));
  write('index.html');
  write('docs/gitquire/overview/index.html');
  write('images/a.png');
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

test('extracts href and src attributes', () => {
  assert.deepEqual(extractTargets('<a href="/x/?a=1&amp;b=2">x</a><img src="/y.png">'), [
    '/x/?a=1&b=2',
    '/y.png',
  ]);
});

test('accepts pages and files under the base path', () => {
  assert.equal(checkTarget(out, '/GitQuire', '/GitQuire/'), null);
  assert.equal(checkTarget(out, '/GitQuire', '/GitQuire/docs/gitquire/overview/#where'), null);
  assert.equal(checkTarget(out, '/GitQuire', '/GitQuire/docs/gitquire/overview'), null);
  assert.equal(checkTarget(out, '/GitQuire', '/GitQuire/images/a.png'), null);
});

test('ignores external, relative and fragment links', () => {
  assert.equal(checkTarget(out, '/GitQuire', 'https://github.com/docdru/GitQuire'), null);
  assert.equal(checkTarget(out, '/GitQuire', '//cdn.example.com/a.js'), null);
  assert.equal(checkTarget(out, '/GitQuire', '#top'), null);
  assert.equal(checkTarget(out, '/GitQuire', 'mailto:a@example.com'), null);
});

test('flags links without the base path', () => {
  assert.equal(checkTarget(out, '/GitQuire', '/docs/gitquire/overview'), 'missing the base path');
});

test('flags links to pages that were not built', () => {
  assert.equal(checkTarget(out, '/GitQuire', '/GitQuire/docs/changelog/'), 'no such file in the build');
});

test('reports each broken target with the pages that use it', () => {
  write('docs/gitquire/overview/index.html', '<a href="/GitQuire/docs/changelog/">c</a>');
  write('docs/x/index.html', '<a href="/GitQuire/docs/changelog/">c</a><img src="/images/a.png">');
  const broken = findBrokenLinks(out, '/GitQuire');
  assert.deepEqual([...broken.keys()].sort(), [
    '/GitQuire/docs/changelog/ (no such file in the build)',
    '/images/a.png (missing the base path)',
  ]);
  assert.equal(broken.get('/GitQuire/docs/changelog/ (no such file in the build)').length, 2);
});
