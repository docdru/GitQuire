import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

export function useIsolatedHome(): () => string {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ok-git-hosts-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('GITQUIRE_CHANNEL', 'stable');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  return () => home;
}

export function writeUserConfig(home: string, body: string): void {
  mkdirSync(join(home, '.gitquire'), { recursive: true });
  writeFileSync(join(home, '.gitquire', 'global.yml'), body, 'utf-8');
}

export function gitHostsYaml(...hosts: string[]): string {
  return `git:\n  hosts:\n${hosts.map((h) => `    ${h}:\n      provider: github\n`).join('')}`;
}

export function declareGitHubHosts(home: string, ...hosts: string[]): void {
  writeUserConfig(home, gitHostsYaml(...hosts));
}
