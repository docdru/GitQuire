import type { HostKind, HostNames, HostPerson } from './types.ts';

export class HostConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const GITHUB_EMAIL_FORMAT = '{id}+{login}@users.noreply.github.com';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function parseHostKind(env: Env): HostKind {
  const raw = nonEmpty(env.GITQUIRE_HOST)?.toLowerCase();
  if (raw === undefined || raw === 'github') return 'github';
  if (raw === 'forgejo') return 'forgejo';
  throw new HostConfigError(`GITQUIRE_HOST must be github or forgejo, got "${raw}".`);
}

export function parseEmailFormat(raw: string | undefined, fallback: string): string {
  const format = nonEmpty(raw) ?? fallback;
  const sample = format.replaceAll('{id}', '1').replaceAll('{login}', 'a');
  if (!format.includes('{login}') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sample)) {
    throw new HostConfigError(
      `GITQUIRE_COMMIT_EMAIL_FORMAT must be an email address with {login} in it (and optionally {id}), for example {login}@noreply.example.org, got "${format}".`,
    );
  }
  return format;
}

export function emailFromFormat(format: string, person: Pick<HostPerson, 'id' | 'login'>): string {
  return format.replaceAll('{id}', String(person.id)).replaceAll('{login}', person.login);
}

export function gitHubNames(emailFormat: string = GITHUB_EMAIL_FORMAT): HostNames {
  return {
    kind: 'github',
    label: 'GitHub',
    idPrefix: 'github-',
    noreplyEmail: (person) => emailFromFormat(emailFormat, person),
  };
}

let current: HostNames = gitHubNames();

export function forgejoNames(emailFormat: string): HostNames {
  return {
    kind: 'forgejo',
    label: 'Forgejo',
    idPrefix: 'forgejo-',
    noreplyEmail: (person) => emailFromFormat(emailFormat, person),
  };
}

function forgejoDefaultEmailFormat(env: Env): string {
  const raw = nonEmpty(env.GITQUIRE_HOST_URL);
  if (raw === undefined) {
    throw new HostConfigError(
      'GITQUIRE_HOST=forgejo needs GITQUIRE_HOST_URL, the address of the Forgejo server.',
    );
  }
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    throw new HostConfigError(`GITQUIRE_HOST_URL is not a valid URL: "${raw}".`);
  }
  return `{login}@noreply.${hostname}`;
}

export function hostNamesFromEnv(env: Env): HostNames {
  const kind = parseHostKind(env);
  if (kind === 'forgejo') {
    return forgejoNames(
      parseEmailFormat(env.GITQUIRE_COMMIT_EMAIL_FORMAT, forgejoDefaultEmailFormat(env)),
    );
  }
  return gitHubNames(parseEmailFormat(env.GITQUIRE_COMMIT_EMAIL_FORMAT, GITHUB_EMAIL_FORMAT));
}

export function signInPath(names: HostNames = current): string {
  return `/auth/${names.kind}/login`;
}

export function callbackPath(names: HostNames = current): string {
  return `/auth/${names.kind}/callback`;
}

export function hostNames(): HostNames {
  return current;
}

export function setHostNames(next: HostNames): void {
  current = next;
}

export function resetHostNames(): void {
  current = gitHubNames();
}
