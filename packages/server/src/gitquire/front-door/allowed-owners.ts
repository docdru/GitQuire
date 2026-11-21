import type { HostRepoRecord } from '../host/types.ts';

export interface AllowedOwners {
  names: ReadonlySet<string>;
  pinned: () => Readonly<Record<string, number>>;
  pin: (owner: string, id: number) => void;
}

function listedName(
  owners: AllowedOwners,
  repo: Pick<HostRepoRecord, 'owner' | 'ownerId'>,
): string | undefined {
  const pinned = owners.pinned();
  for (const name of owners.names) {
    const id = pinned[name];
    if (id !== undefined) {
      if (id === repo.ownerId) return name;
      continue;
    }
    if (name === repo.owner.toLowerCase()) return name;
  }
  return undefined;
}

export function ownerAllowed(
  owners: AllowedOwners,
  repo: Pick<HostRepoRecord, 'owner' | 'ownerId'>,
): boolean {
  return listedName(owners, repo) !== undefined;
}

export function pinAllowedOwner(
  owners: AllowedOwners,
  repo: Pick<HostRepoRecord, 'owner' | 'ownerId'>,
): void {
  const name = listedName(owners, repo);
  if (name !== undefined && owners.pinned()[name] === undefined) owners.pin(name, repo.ownerId);
}

export function allowedOwnersSentence(owners: AllowedOwners): string {
  const names = [...owners.names].sort();
  return `This server hosts wikis from ${names.join(', ')}.`;
}
