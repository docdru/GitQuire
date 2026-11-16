import { expect, test } from 'vitest';
import { legacyCommandNotice } from './legacy-command-name.ts';

test.each(['/usr/local/bin/ok', '/usr/local/bin/open-knowledge', 'ok'])(
  'invoking the old name %s prints the new name',
  (path) => {
    expect(legacyCommandNotice(path)).toContain('is now `gq` (or `gitquire`)');
  },
);

test.each([
  '/usr/local/bin/gq',
  '/usr/local/bin/gitquire',
  '/repo/packages/cli/dist/cli.mjs',
  undefined,
])('invoking %s prints nothing', (path) => {
  expect(legacyCommandNotice(path)).toBeNull();
});
