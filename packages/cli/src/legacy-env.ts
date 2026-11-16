const LEGACY_PREFIX = 'OK_';
const PREFIX = 'GITQUIRE_';

export function adoptLegacyEnv(env: Record<string, string | undefined>): string[] {
  const adopted: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_PREFIX) || value === undefined) continue;
    const renamed = `${PREFIX}${name.slice(LEGACY_PREFIX.length)}`;
    if (env[renamed] !== undefined) continue;
    env[renamed] = value;
    adopted.push(name);
  }
  return adopted.sort();
}

export function legacyEnvNotice(name: string): string {
  return `The environment variable ${name} is now ${PREFIX}${name.slice(LEGACY_PREFIX.length)}. The old name still works for now and will be removed in a later version.\n`;
}
