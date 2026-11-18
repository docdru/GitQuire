import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { GQ_TRAILING_AFFORDANCE_CLASS } from './editor/extensions/trailing-affordance.ts';

const SRC_PATH = join(__dirname, 'globals.css');
const src = readFileSync(SRC_PATH, 'utf-8');

describe('globals.css agent-flash widget exclusion', () => {
  test('the append filter names the class the trailing-affordance plugin renders', () => {
    expect(src).toContain(`of :not(.${GQ_TRAILING_AFFORDANCE_CLASS},`);
  });

  test('the append filter also names the gap cursor', () => {
    expect(src).toContain('.ProseMirror-gapcursor)');
  });
});
