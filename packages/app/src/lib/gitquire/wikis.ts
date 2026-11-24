import { type ApiDeps, gitquireRequest } from './branch-api';
import { FRONT_DOOR_API } from './wiki-prefix';

export interface DoorWiki {
  key: string;
  hostKey: string;
  hostLabel: string;
  fullName: string;
  owner: string;
  name: string;
  address: string;
  admin: boolean;
  state: 'on' | 'disconnected';
  why: string | null;
  unread: number;
}

export interface DoorSignIn {
  host: string;
  label: string;
  address: string;
}

export interface DoorWikis {
  wikis: DoorWiki[];
  hosts: string;
  addWikiPage: string;
  signInWith: DoorSignIn[];
  severalHosts: boolean;
}

function signInFrom(value: unknown): DoorSignIn | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.host !== 'string' ||
    typeof v.label !== 'string' ||
    typeof v.address !== 'string' ||
    !/^\/auth\/[a-z][a-z0-9-]*\/login$/.test(v.address)
  ) {
    return undefined;
  }
  return { host: v.host, label: v.label, address: v.address };
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
    !/^\/w\/[^/]+\/[^/]+\/[^/]+\/$/.test(v.address)
  ) {
    return undefined;
  }
  const hostKey = typeof v.hostKey === 'string' ? v.hostKey : (v.address.split('/')[2] ?? '');
  return {
    key: v.key,
    hostKey,
    hostLabel: typeof v.hostLabel === 'string' ? v.hostLabel : hostKey,
    fullName: typeof v.fullName === 'string' ? v.fullName : `${hostKey}/${v.owner}/${v.name}`,
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
    severalHosts: Array.isArray(v.accounts),
    signInWith: Array.isArray(v.signInWith)
      ? v.signInWith.map(signInFrom).filter((item): item is DoorSignIn => item !== undefined)
      : [],
  };
}

export async function fetchDoorWikis(deps: ApiDeps = {}): Promise<DoorWikis | null> {
  return parseDoorWikis(await gitquireRequest(`${FRONT_DOOR_API}/wikis`, {}, deps));
}
