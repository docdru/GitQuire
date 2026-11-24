import { forgejoNames, gitHubNames } from '../host/names.ts';
import type { DoorHost } from '../host/types.ts';
import type { WikiAccess } from './access.ts';
import type { AllowedOwners } from './allowed-owners.ts';
import { type DoorHostEntry, type DoorHosts, doorHostPaths, doorHosts } from './door-hosts.ts';
import type { HostSettings } from './hosts.ts';
import type { AddWikiHelp } from './pages.ts';
import type { ForgejoTokenChecks } from './server.ts';
import type { FrontDoorSettings } from './settings.ts';

export function hostSettingsForTest(
  settings: Pick<
    FrontDoorSettings,
    | 'host'
    | 'webUrl'
    | 'apiUrl'
    | 'clientId'
    | 'clientSecret'
    | 'githubApp'
    | 'forgejoBotToken'
    | 'allowedOwners'
    | 'serverAdmins'
  >,
  extra: Partial<HostSettings> = {},
): HostSettings {
  const kind = extra.kind ?? settings.host;
  const key = extra.key ?? kind;
  const base = kind === 'forgejo' ? forgejoNames('{login}@noreply.host.example') : gitHubNames();
  return {
    key,
    kind,
    label: base.label,
    primary: true,
    webUrl: settings.webUrl,
    apiUrl: settings.apiUrl,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    githubApp: settings.githubApp,
    forgejoBotToken: settings.forgejoBotToken,
    allowedOwners: settings.allowedOwners,
    serverAdmins: settings.serverAdmins,
    commitEmailFormat: undefined,
    names: { ...base, idPrefix: `${key}-` },
    ...extra,
  };
}

export function entryForTest(input: {
  settings: HostSettings;
  host: DoorHost;
  access: WikiAccess;
  owners: AllowedOwners;
  forgejoTokens?: ForgejoTokenChecks;
  addWikiHelp?: () => Promise<AddWikiHelp>;
}): DoorHostEntry {
  return {
    key: input.settings.key,
    settings: input.settings,
    names: input.settings.names,
    host: input.host,
    access: input.access,
    owners: input.owners,
    paths: doorHostPaths(input.settings.key),
    ...(input.forgejoTokens === undefined ? {} : { forgejoTokens: input.forgejoTokens }),
    ...(input.addWikiHelp === undefined ? {} : { addWikiHelp: input.addWikiHelp }),
  };
}

export function hostsForTest(...entries: DoorHostEntry[]): DoorHosts {
  return doorHosts(entries);
}
