import { loginSet } from '../github-auth-config.ts';
import { emailFromFormat, parseEmailFormat } from '../host/names.ts';
import type { HostKind, HostNames } from '../host/types.ts';

type Env = Readonly<Record<string, string | undefined>>;

export class HostListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostListError';
  }
}

export interface HostSettings {
  readonly key: string;
  readonly kind: HostKind;
  readonly label: string;
  readonly primary: boolean;
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly githubApp: { appId: string; privateKeyPem: string } | undefined;
  forgejoBotToken: string | undefined;
  allowedOwners: ReadonlySet<string>;
  serverAdmins: ReadonlySet<string>;
  names: HostNames;
}

export const HOST_KEY_RE = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const KINDS: readonly HostKind[] = ['github', 'forgejo'];
const KIND_LABEL: Record<HostKind, string> = { github: 'GitHub', forgejo: 'Forgejo' };
const FIRST_HOST_VARIABLES = [
  'GITQUIRE_HOST_URL',
  'GITQUIRE_HOST_API_URL',
  'GITQUIRE_HOST_CLIENT_ID',
  'GITQUIRE_HOST_CLIENT_SECRET',
  'GITQUIRE_HOST_CLIENT_SECRET_FILE',
  'GITQUIRE_HOST_TOKEN',
  'GITQUIRE_HOST_TOKEN_FILE',
  'GITQUIRE_HOST_REPO_TOKEN',
  'GITQUIRE_HOST_REPO_TOKEN_FILE',
  'GITQUIRE_HOST_KEY',
  'GITQUIRE_HOST_LABEL',
];
const RESERVED_FIRST_SEGMENTS = new Set(
  FIRST_HOST_VARIABLES.map((name) =>
    (name.slice('GITQUIRE_HOST_'.length).split('_')[0] as string).toLowerCase(),
  ),
);
const RESERVED_KEYS = new Set(['agents', 'logout', 'me', 'login', 'callback', 'add-wiki', 'w']);
const SUFFIXES = [
  'KIND',
  'LABEL',
  'URL',
  'API_URL',
  'CLIENT_ID',
  'CLIENT_SECRET',
  'CLIENT_SECRET_FILE',
  'TOKEN',
  'TOKEN_FILE',
  'APP_ID',
  'APP_PRIVATE_KEY',
  'APP_PRIVATE_KEY_FILE',
  'ALLOWED_OWNERS',
  'ADMINS',
  'COMMIT_EMAIL_FORMAT',
] as const;
export type HostVariableSuffix = (typeof SUFFIXES)[number];
type Suffix = HostVariableSuffix;

export function hostKeyOf(record: { host: HostKind; hostKey?: string }): string {
  return record.hostKey ?? record.host;
}

export function hostNamesFor(
  kind: HostKind,
  key: string,
  label: string,
  emailFormat: string,
): HostNames {
  return {
    kind,
    label,
    idPrefix: `${key}-`,
    noreplyEmail: (person) => emailFromFormat(emailFormat, person),
  };
}

export function hostVariable(key: string, suffix: Suffix): string {
  return `GITQUIRE_HOST_${key.toUpperCase().replaceAll('-', '_')}_${suffix}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function httpsBase(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HostListError(`${name} is not a valid URL: "${raw}".`);
  }
  if (url.protocol !== 'https:') {
    throw new HostListError(
      `${name} must start with https://: GitQuire only sends a host's tokens over https.`,
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new HostListError(`${name} must be a plain address, without a user, query or #part.`);
  }
  return stripTrailingSlash(`${url.origin}${url.pathname}`);
}

export function furtherHostKeys(env: Env): string[] {
  const raw = nonEmpty(env.GITQUIRE_HOSTS);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
}

function checkKeys(primary: HostSettings, keys: readonly string[]): void {
  const seen = new Set<string>([primary.key]);
  for (const key of keys) {
    if (!HOST_KEY_RE.test(key)) {
      throw new HostListError(
        `"${key}" in GITQUIRE_HOSTS is not a host key: use lowercase letters, digits and dashes, starting with a letter, at most 32 characters.`,
      );
    }
    if (RESERVED_KEYS.has(key)) {
      throw new HostListError(
        `"${key}" cannot be a host key: GitQuire already uses /auth/${key}. Choose another key.`,
      );
    }
    if (RESERVED_FIRST_SEGMENTS.has(key.split('-')[0] as string)) {
      throw new HostListError(
        `"${key}" cannot be a host key: its variables would be mistaken for the first host's (GITQUIRE_HOST_URL and the like). Choose another key.`,
      );
    }
    if (seen.has(key)) {
      throw new HostListError(
        key === primary.key
          ? `GITQUIRE_HOSTS lists "${key}", the key of the first host (set by GITQUIRE_HOST). List only the further hosts, and give a further host of the same kind a key of its own.`
          : `GITQUIRE_HOSTS lists "${key}" twice.`,
      );
    }
    seen.add(key);
  }
  const all = [primary.key, ...keys, ...KINDS];
  for (const key of keys) {
    const parts = key.split('-');
    for (let end = 1; end < parts.length; end += 1) {
      const head = parts.slice(0, end).join('-');
      if (all.includes(head)) {
        throw new HostListError(
          `The host key "${key}" begins with "${head}-", the key of another host or a kind: people of the two hosts would get ids that start alike. Choose a key that does not.`,
        );
      }
    }
  }
  const names = new Map<string, string>();
  for (const key of keys) {
    for (const suffix of SUFFIXES) {
      const name = hostVariable(key, suffix);
      const other = names.get(name);
      if (other !== undefined) {
        throw new HostListError(
          `The host keys "${other}" and "${key}" would share the variable ${name}. Rename one of them.`,
        );
      }
      names.set(name, key);
    }
  }
}

function secret(
  env: Env,
  name: string,
  readFile: (path: string) => string,
  fileName: string = `${name}_FILE`,
  keep: (text: string) => string | undefined = nonEmpty,
): string | undefined {
  const inline = nonEmpty(env[name]);
  if (inline !== undefined) return inline;
  const file = nonEmpty(env[fileName]);
  if (file === undefined) return undefined;
  try {
    return keep(readFile(file));
  } catch (err) {
    throw new HostListError(
      `Could not read ${fileName} (${file}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function furtherHost(
  env: Env,
  key: string,
  readFile: (path: string) => string,
  usedLabels: Set<string>,
): HostSettings {
  const name = (suffix: Suffix) => hostVariable(key, suffix);
  const kindRaw = nonEmpty(env[name('KIND')])?.toLowerCase() ?? key;
  if (!KINDS.includes(kindRaw as HostKind)) {
    throw new HostListError(
      `${name('KIND')} must be github or forgejo${nonEmpty(env[name('KIND')]) === undefined ? ` (it can be left out only when the key is the kind)` : `, got "${kindRaw}"`}.`,
    );
  }
  const kind = kindRaw as HostKind;
  if (KINDS.includes(key as HostKind) && key !== kind) {
    throw new HostListError(
      `The host key "${key}" names the other kind of host. Give this ${KIND_LABEL[kind]} host another key.`,
    );
  }
  const missing: string[] = [];
  const clientId = nonEmpty(env[name('CLIENT_ID')]);
  const clientSecret = secret(env, name('CLIENT_SECRET'), readFile);
  if (clientId === undefined) missing.push(name('CLIENT_ID'));
  if (clientSecret === undefined) missing.push(`${name('CLIENT_SECRET')} (or _FILE)`);
  const allowedOwners = loginSet(env[name('ALLOWED_OWNERS')]);
  if (allowedOwners.size === 0) missing.push(name('ALLOWED_OWNERS'));
  let webUrl: string;
  let apiUrl: string;
  let githubApp: HostSettings['githubApp'];
  let forgejoBotToken: string | undefined;
  if (kind === 'github') {
    webUrl = httpsBase(nonEmpty(env[name('URL')]) ?? 'https://github.com', name('URL'));
    const givenApi = nonEmpty(env[name('API_URL')]);
    apiUrl =
      givenApi !== undefined
        ? httpsBase(givenApi, name('API_URL'))
        : webUrl === 'https://github.com'
          ? 'https://api.github.com'
          : `${webUrl}/api/v3`;
    const appId = nonEmpty(env[name('APP_ID')]);
    const inlinePem = nonEmpty(env[name('APP_PRIVATE_KEY')])?.replace(/\\n/g, '\n');
    const pem =
      inlinePem ??
      secret(env, '', readFile, name('APP_PRIVATE_KEY_FILE'), (text) =>
        text.trim() === '' ? undefined : text,
      );
    if (appId === undefined) missing.push(name('APP_ID'));
    if (pem === undefined) {
      missing.push(`${name('APP_PRIVATE_KEY_FILE')} (or ${name('APP_PRIVATE_KEY')})`);
    }
    if (pem !== undefined && !pem.includes('PRIVATE KEY-----')) {
      throw new HostListError(
        `The private key of the GitHub host "${key}" is not a PEM file. Download it from the GitHub App's settings page.`,
      );
    }
    if (appId !== undefined && pem !== undefined) githubApp = { appId, privateKeyPem: pem };
  } else {
    const web = nonEmpty(env[name('URL')]);
    if (web === undefined) missing.push(name('URL'));
    webUrl = web === undefined ? '' : httpsBase(web, name('URL'));
    if (web !== undefined && new URL(web).pathname.replace(/\/+$/, '') !== '') {
      throw new HostListError(`${name('URL')} must be the Forgejo server's root address.`);
    }
    apiUrl =
      nonEmpty(env[name('API_URL')]) === undefined
        ? `${webUrl}/api/v1`
        : httpsBase(nonEmpty(env[name('API_URL')]) as string, name('API_URL'));
    forgejoBotToken = secret(env, name('TOKEN'), readFile);
    if (forgejoBotToken === undefined) missing.push(`${name('TOKEN')} (or _FILE)`);
  }
  if (missing.length > 0 || clientId === undefined || clientSecret === undefined) {
    throw new HostListError(`The host "${key}" in GITQUIRE_HOSTS needs: ${missing.join(', ')}.`);
  }
  const given = nonEmpty(env[name('LABEL')]);
  let label = given ?? KIND_LABEL[kind];
  if (usedLabels.has(label.toLowerCase())) {
    if (given !== undefined) {
      throw new HostListError(
        `Two hosts are labelled "${label}". Give ${name('LABEL')} another one.`,
      );
    }
    label = `${label} (${key})`;
  }
  usedLabels.add(label.toLowerCase());
  const defaultFormat =
    kind === 'github'
      ? '{id}+{login}@users.noreply.github.com'
      : `{login}@noreply.${new URL(webUrl).hostname}`;
  let emailFormat: string;
  try {
    emailFormat = parseEmailFormat(env[name('COMMIT_EMAIL_FORMAT')], defaultFormat);
  } catch (err) {
    throw new HostListError(
      (err instanceof Error ? err.message : String(err)).replace(
        'GITQUIRE_COMMIT_EMAIL_FORMAT',
        name('COMMIT_EMAIL_FORMAT'),
      ),
    );
  }
  return {
    key,
    kind,
    label,
    primary: false,
    webUrl,
    apiUrl,
    clientId,
    clientSecret,
    githubApp,
    forgejoBotToken,
    allowedOwners,
    serverAdmins: loginSet(env[name('ADMINS')]),
    names: hostNamesFor(kind, key, label, emailFormat),
  };
}

export function hostList(
  env: Env,
  primary: HostSettings,
  readFile: (path: string) => string,
): readonly HostSettings[] {
  const keys = furtherHostKeys(env);
  checkKeys(primary, keys);
  const labels = new Set([primary.label.toLowerCase()]);
  const hosts = [primary, ...keys.map((key) => furtherHost(env, key, readFile, labels))];
  const origins = new Map<string, string>();
  for (const host of hosts) {
    for (const address of [host.webUrl, host.apiUrl]) {
      const origin = new URL(address).origin;
      const other = origins.get(origin);
      if (other !== undefined && other !== host.key) {
        throw new HostListError(
          `The hosts "${other}" and "${host.key}" have the same address ${origin}. Configure each Git server once.`,
        );
      }
      origins.set(origin, host.key);
    }
  }
  return hosts;
}

export function hostByKey(hosts: readonly HostSettings[], key: string): HostSettings | undefined {
  return hosts.find((host) => host.key === key);
}
