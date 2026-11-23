import { type ApiDeps, gitquireRequest } from './branch-api';
import { FRONT_DOOR_API } from './wiki-prefix';

export interface DoorWiki {
  key: string;
  owner: string;
  name: string;
  address: string;
  admin: boolean;
  state: 'on' | 'disconnected';
  why: string | null;
  unread: number;
}

export interface DoorWikis {
  wikis: DoorWiki[];
  hosts: string;
  addWikiPage: string;
}

function countFrom(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function unreadElsewhere(door: DoorWikis | null, address: string): number {
  if (door === null) return 0;
  return door.wikis.reduce((sum, wiki) => (wiki.address === address ? sum : sum + wiki.unread), 0);
}

function wikiFrom(value: unknown): DoorWiki | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.key !== 'string' ||
    typeof v.owner !== 'string' ||
    typeof v.name !== 'string' ||
    typeof v.address !== 'string' ||
    !/^\/w\/[^/]+\/[^/]+\/$/.test(v.address)
  ) {
    return undefined;
  }
  return {
    key: v.key,
    owner: v.owner,
    name: v.name,
    address: v.address,
    admin: v.admin === true,
    state: v.state === 'on' ? 'on' : 'disconnected',
    why: typeof v.why === 'string' ? v.why : null,
    unread: countFrom(v.unread),
  };
}

export function parseDoorWikis(body: unknown): DoorWikis | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = body as Record<string, unknown>;
  if (!Array.isArray(v.wikis)) return null;
  const page =
    typeof v.addWikiPage === 'string' && /^\/[^/\\]/.test(v.addWikiPage)
      ? v.addWikiPage
      : '/add-wiki';
  return {
    wikis: v.wikis.map(wikiFrom).filter((wiki): wiki is DoorWiki => wiki !== undefined),
    hosts: typeof v.hosts === 'string' ? v.hosts : '',
    addWikiPage: page,
  };
}

export async function fetchDoorWikis(deps: ApiDeps = {}): Promise<DoorWikis | null> {
  return parseDoorWikis(await gitquireRequest(`${FRONT_DOOR_API}/wikis`, {}, deps));
}
