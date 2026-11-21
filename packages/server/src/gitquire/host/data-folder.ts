import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostConfigError } from './names.ts';
import type { HostKind } from './types.ts';

const STATE_WITH_PERSON_IDS = [
  'people.json',
  'mentions.json',
  'agent-tokens.json',
  'drafts.json',
  'users',
  'chats',
];

function stateDir(projectDir: string): string {
  return join(projectDir, '.gitquire', 'local', 'gitquire');
}

export function dataFolderHostFile(projectDir: string): string {
  return join(stateDir(projectDir), 'host.json');
}

function recordedHost(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { host?: unknown };
    return typeof parsed.host === 'string' ? parsed.host : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

export function checkDataFolderHost(
  projectDir: string,
  kind: HostKind,
  moreStateFiles: readonly string[] = [],
): void {
  const file = dataFolderHostFile(projectDir);
  const recorded = recordedHost(file);
  if (recorded !== undefined) {
    if (recorded === kind) return;
    throw new HostConfigError(
      `This data folder belongs to a GitQuire server for ${recorded === 'unreadable' ? 'an unknown host' : recorded}, but GITQUIRE_HOST is ${kind}. People's ids from two hosts must not be mixed: use a new volume, or set GITQUIRE_HOST back. (${file})`,
    );
  }
  if (kind === 'github') return;
  const dir = stateDir(projectDir);
  const used = [...STATE_WITH_PERSON_IDS.map((name) => join(dir, name)), ...moreStateFiles].filter(
    (path) => existsSync(path),
  );
  if (used.length > 0) {
    throw new HostConfigError(
      `This data folder was used with GitHub (${used.join(', ')}), but GITQUIRE_HOST is ${kind}. People's ids from two hosts must not be mixed: use a new volume for ${kind}.`,
    );
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ host: kind })}\n`, { mode: 0o600 });
}
