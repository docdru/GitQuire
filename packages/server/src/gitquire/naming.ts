import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyNamingRule,
  type NamingRule,
  parseNamingRule,
  titleSeed,
} from '@inkeep/open-knowledge-core/gitquire/naming';

type Env = Readonly<Record<string, string | undefined>>;

export function namingRuleFromEnv(env: Env = process.env): NamingRule {
  return parseNamingRule(env.GITQUIRE_NAMING);
}

function isExistingFolder(contentDir: string, folder: string): boolean {
  const full = join(contentDir, folder);
  return existsSync(full) && statSync(full).isDirectory();
}

export function nameRequestedPath(
  contentDir: string,
  path: string,
  lastIsFile: boolean,
  env: Env = process.env,
): string {
  return applyNamingRule(path, {
    rule: namingRuleFromEnv(env),
    lastIsFile,
    keepFolder: (folder) => isExistingFolder(contentDir, folder),
  });
}

export function titleSeedFor(requestedPath: string, namedPath: string): string {
  return titleSeed(requestedPath, namedPath);
}
