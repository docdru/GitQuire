import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setTomlConfigEngineForTesting } from '../native/toml-config-engine.ts';
import { EDITOR_TARGETS, type EditorMcpTarget } from './editors.ts';
import { writeEditorMcpConfig } from './init.ts';

const unix = process.platform !== 'win32';
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function targetForFile(base: EditorMcpTarget, configPath: string): EditorMcpTarget {
  return { ...base, configPath: () => configPath };
}

function write(base: EditorMcpTarget, configPath: string) {
  return writeEditorMcpConfig(targetForFile(base, configPath), '', {
    mode: 'published',
    skipAvailabilityCheck: true,
  });
}

afterEach(() => {
  setTomlConfigEngineForTesting(null);
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('symlink write-through on the harness write path', () => {
  it.skipIf(!unix)('writes a JSON harness through a symlink, leaving the symlink intact', () => {
    const home = tempDir('ok-symlink-home-');
    const repo = tempDir('ok-symlink-repo-');
    const target = join(repo, 'mcp.json');
    const original = [
      '{',
      '  // dotfiles-managed cursor config',
      '  "mcpServers": {',
      '    "existing": { "command": "x" }',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(target, original);
    const config = join(home, 'mcp.json');
    symlinkSync(target, config);

    const result = write(EDITOR_TARGETS.cursor, config);
    expect(result.action).toBe('written');

    expect(lstatSync(config).isSymbolicLink()).toBe(true);
    const after = readFileSync(target, 'utf-8');
    expect(after).toContain('// dotfiles-managed cursor config');
    expect(after).toContain('"existing"');
    expect(after).toContain('open-knowledge');
  });

  it.skipIf(!unix)('breaks a cyclic symlink into a regular file carrying our entry', () => {
    const home = tempDir('ok-symlink-home-');
    symlinkSync('b.json', join(home, 'a.json'));
    symlinkSync('a.json', join(home, 'b.json'));
    const config = join(home, 'config.json');
    symlinkSync('a.json', config);

    const result = write(EDITOR_TARGETS.cursor, config);
    expect(result.action).toBe('written');

    expect(lstatSync(config).isSymbolicLink()).toBe(false);
    expect(readFileSync(config, 'utf-8')).toContain('open-knowledge');
  });
});
