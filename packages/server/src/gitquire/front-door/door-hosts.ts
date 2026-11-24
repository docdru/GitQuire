import { createAppJwt } from '../github-app.ts';
import { createForgejoDoorHost, type ForgejoRepoTokens } from '../host/forgejo.ts';
import { createGitHubDoorHost } from '../host/github.ts';
import type { DoorHost, HostNames, HostRepoRef } from '../host/types.ts';
import type { WikiAccess } from './access.ts';
import type { AllowedOwners } from './allowed-owners.ts';
import { type HostSettings, hostKeyOf } from './hosts.ts';
import type { AddWikiHelp } from './pages.ts';
import type { ForgejoTokenChecks } from './server.ts';

export interface DoorHostPaths {
  login: string;
  callback: string;
  addWiki: string;
}

export interface DoorHostEntry {
  key: string;
  settings: HostSettings;
  names: HostNames;
  host: DoorHost;
  access: WikiAccess;
  owners: AllowedOwners;
  paths: DoorHostPaths;
  forgejoTokens?: ForgejoTokenChecks;
  addWikiHelp?: () => Promise<AddWikiHelp>;
}

export interface DoorHosts {
  readonly primary: DoorHostEntry;
  list: () => readonly DoorHostEntry[];
  byKey: (key: string) => DoorHostEntry | undefined;
  of: (wiki: { host: HostSettings['kind']; hostKey?: string }) => DoorHostEntry | undefined;
}

export function doorHostPaths(key: string): DoorHostPaths {
  return {
    login: `/auth/${key}/login`,
    callback: `/auth/${key}/callback`,
    addWiki: `/auth/${key}/add-wiki`,
  };
}

export function personIdOn(names: Pick<HostNames, 'idPrefix'>, id: number): string {
  return `${names.idPrefix}${id}`;
}

export function doorHostFor(
  settings: Pick<HostSettings, 'kind' | 'webUrl' | 'apiUrl' | 'forgejoBotToken' | 'githubApp'>,
  repoToken: ForgejoRepoTokens['tokenFor'],
): DoorHost {
  if (settings.kind === 'forgejo') {
    return createForgejoDoorHost(
      { webUrl: settings.webUrl, apiUrl: settings.apiUrl, repo: undefined },
      { botToken: () => settings.forgejoBotToken, repoTokens: { tokenFor: repoToken } },
    );
  }
  return createGitHubDoorHost(
    { webUrl: settings.webUrl, apiUrl: settings.apiUrl, repo: undefined },
    {
      app: {
        jwt: () => {
          const app = settings.githubApp;
          if (app === undefined) throw new Error('No GitHub App key.');
          return createAppJwt(app.appId, app.privateKeyPem, Date.now());
        },
      },
    },
  );
}

export function trialKey(repo: HostRepoRef): string {
  return repo.id === undefined
    ? `name:${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`
    : `id:${repo.id}`;
}

export function doorHosts(entries: readonly DoorHostEntry[]): DoorHosts {
  const primary = entries[0];
  if (primary === undefined) throw new Error('The front door needs at least one host.');
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return {
    primary,
    list: () => entries,
    byKey: (key) => byKey.get(key),
    of: (wiki) => {
      const entry = byKey.get(hostKeyOf(wiki));
      return entry?.settings.kind === wiki.host ? entry : undefined;
    },
  };
}
