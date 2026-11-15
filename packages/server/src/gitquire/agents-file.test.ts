import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AGENTS_SECTION,
  AGENTS_SECTION_BEGIN,
  AGENTS_SECTION_END,
  ensureAgentsFile,
  withAgentsSection,
} from './agents-file.ts';

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const block = `${AGENTS_SECTION_BEGIN}\n${AGENTS_SECTION}\n${AGENTS_SECTION_END}`;

describe('AGENTS.md section', () => {
  test('creates the file with only the GitQuire section', () => {
    expect(withAgentsSection(undefined)).toBe(`${block}\n`);
  });

  test('appends the section to a file the team wrote and keeps their text', () => {
    expect(withAgentsSection('# Our rules\n\nBe kind.\n')).toBe(
      `# Our rules\n\nBe kind.\n\n${block}\n`,
    );
  });

  test('replaces an older section in place and leaves the rest alone', () => {
    const old = `Intro\n\n${AGENTS_SECTION_BEGIN}\nold rules\n${AGENTS_SECTION_END}\n\nOutro\n`;
    expect(withAgentsSection(old)).toBe(`Intro\n\n${block}\n\nOutro\n`);
  });

  test('the section describes the comment format GitQuire writes', () => {
    expect(AGENTS_SECTION).toContain('[^c-7f3a]: 💬 on "quarterly numbers"');
    expect(AGENTS_SECTION).toContain('- **@alice** · 2026-11-14 10:32 — Where do these come from?');
  });

  test('writes once, then leaves an up-to-date file alone, and can be turned off', () => {
    dir = mkdtempSync(join(tmpdir(), 'gq-agents-'));
    expect(ensureAgentsFile(dir, {})).toBe('created');
    expect(ensureAgentsFile(dir, {})).toBe('unchanged');
    writeFileSync(join(dir, 'AGENTS.md'), '# Ours\n');
    expect(ensureAgentsFile(dir, { GITQUIRE_AGENTS_FILE: 'off' })).toBe('off');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# Ours\n');
    expect(ensureAgentsFile(dir, {})).toBe('updated');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(`# Ours\n\n${block}\n`);
  });
});
