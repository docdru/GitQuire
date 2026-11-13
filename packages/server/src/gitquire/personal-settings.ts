import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigSchema } from '@inkeep/open-knowledge-core';
import { parseDocument } from 'yaml';

export const MAX_PERSONAL_SETTINGS_BYTES = 32 * 1024;

export function personalSettingsDir(projectDir: string): string {
  return join(projectDir, '.ok', 'local', 'gitquire', 'users');
}

export function personalSettingsPath(projectDir: string, userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error(`invalid GitHub user id: ${userId}`);
  }
  return join(personalSettingsDir(projectDir), `${userId}.yml`);
}

export type PersonalSettingsProblem = 'too-large' | 'invalid-yaml' | 'not-a-mapping' | 'invalid';

export function checkPersonalSettings(yaml: string): PersonalSettingsProblem | undefined {
  if (Buffer.byteLength(yaml, 'utf8') > MAX_PERSONAL_SETTINGS_BYTES) return 'too-large';
  if (yaml.trim() === '') return undefined;
  const document = parseDocument(yaml);
  if (document.errors.length > 0) return 'invalid-yaml';
  const value: unknown = document.toJSON();
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'not-a-mapping';
  return ConfigSchema.safeParse(value).success ? undefined : 'invalid';
}

export interface PersonalSettingsStore {
  read(userId: number): string;
  write(userId: number, yaml: string): void;
}

export function createPersonalSettingsStore(projectDir: string): PersonalSettingsStore {
  return {
    read(userId) {
      const file = personalSettingsPath(projectDir, userId);
      if (!existsSync(file)) return '';
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    },
    write(userId, yaml) {
      const file = personalSettingsPath(projectDir, userId);
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, yaml, { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}
