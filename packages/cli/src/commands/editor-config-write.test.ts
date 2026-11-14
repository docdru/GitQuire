import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPiExtensionSource } from '../integrations/pi-extension.ts';
import { EDITOR_TARGETS, type EditorId, type EditorMcpTarget } from './editors.ts';
import { writeEditorMcpConfig } from './init.ts';

function targetForFile(id: EditorId, configPath: string): EditorMcpTarget {
  return { ...EDITOR_TARGETS[id], configPath: () => configPath };
}

function write(id: EditorId, configPath: string) {
  return writeEditorMcpConfig(targetForFile(id, configPath), '', {
    mode: 'published',
    skipAvailabilityCheck: true,
  });
}

describe('decline carries no config contents', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  function tempFile(name: string): string {
    dir = mkdtempSync(join(tmpdir(), 'ok-decline-'));
    return join(dir, name);
  }

  it('declines an unparseable present config and the result leaks none of its bytes', () => {
    const configPath = tempFile('config.json');
    const secret = 'SUPER_SECRET_TOKEN_xyz';
    writeFileSync(configPath, `{ "mcpServers": { "a": "${secret}" `);

    const result = write('claude', configPath);
    expect(result.action).toBe('declined');
    expect(result.declineReason).toBe('unparseable');
    expect(readFileSync(configPath, 'utf-8')).toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('pi file-drop write path (whole-file sibling of the entry upserts)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function projectDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'ok-acceptance-pi-'));
    return dir;
  }

  function writePi(cwd: string) {
    const target = EDITOR_TARGETS.pi;
    const projPath = target.projectConfigPath?.(cwd);
    if (!projPath) throw new Error('pi projectConfigPath missing');
    return {
      projPath,
      result: writeEditorMcpConfig(
        target,
        cwd,
        { mode: 'published', skipAvailabilityCheck: true },
        undefined,
        projPath,
      ),
    };
  }

  it('drops the managed bridge byte-equal to buildPiExtensionSource, idempotent on re-run', () => {
    const cwd = projectDir();
    const first = writePi(cwd);
    expect(first.result.action).toBe('written');
    const bytes = readFileSync(first.projPath, 'utf-8');
    expect(bytes).toBe(buildPiExtensionSource({ mode: 'published' }));

    const second = writePi(cwd);
    expect(second.result.action).toBe('overwritten');
    expect(readFileSync(second.projPath, 'utf-8')).toBe(bytes);
    expect(readdirSync(dirname(first.projPath)).some((n) => n.includes('.broken-'))).toBe(false);
  });

  it('rewrites a stale or foreign file at the managed path (namespace ownership)', () => {
    const cwd = projectDir();
    const target = EDITOR_TARGETS.pi;
    const projPath = target.projectConfigPath?.(cwd) as string;
    mkdirSync(dirname(projPath), { recursive: true });
    writeFileSync(projPath, '// ok-pi-bridge-v0\n// stale drop\n');
    const stale = writePi(cwd);
    expect(stale.result.action).toBe('overwritten');
    expect(readFileSync(projPath, 'utf-8')).toBe(buildPiExtensionSource({ mode: 'published' }));
  });

  it('refuses to write through a symlinked .pi ancestor (project path safety)', () => {
    const cwd = projectDir();
    const outside = mkdtempSync(join(tmpdir(), 'ok-acceptance-pi-outside-'));
    try {
      symlinkSync(outside, join(cwd, '.pi'));
      const outcome = writePi(cwd);
      expect(outcome.result.action).toBe('failed');
      expect(outcome.result.error).toMatch(/outside the project directory|symbolic link/);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
