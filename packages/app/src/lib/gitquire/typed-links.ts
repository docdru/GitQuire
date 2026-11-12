import { normalizeRelation } from '@inkeep/open-knowledge-core/gitquire/typed-links';
import { useEffect, useSyncExternalStore } from 'react';
import {
  subscribeToBranchChanged,
  subscribeToDocPersisted,
  subscribeToDocumentsChanged,
} from '@/lib/documents-events';
import type { SchemaField } from '@/lib/frontmatter-schema-fields';
import { type ApiDeps, gitquireRequest } from './branch-api';

export type RelationOrigin = 'frontmatter' | 'inline';

export interface TypedLink {
  source: string;
  target: string;
  anchor: string | null;
  relation: string;
  origin: RelationOrigin;
  line: number;
  resolved: boolean;
}

export interface RelationName {
  name: string;
  count: number;
}

export interface TypedLinkList {
  links: TypedLink[];
  relations: RelationName[];
  truncated: boolean;
}

export interface TypedLinkIndex {
  relations: readonly RelationName[];
  between: (source: string, target: string) => string[];
  outgoing: (source: string) => readonly TypedLink[];
  incoming: (target: string) => readonly TypedLink[];
}

const RELOAD_AFTER_CHANGE_MS = 6000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLink(value: unknown): TypedLink | undefined {
  if (!isRecord(value)) return undefined;
  const { source, target, anchor, relation, origin, line, resolved } = value;
  if (typeof source !== 'string' || typeof target !== 'string' || typeof relation !== 'string') {
    return undefined;
  }
  return {
    source,
    target,
    anchor: typeof anchor === 'string' ? anchor : null,
    relation,
    origin: origin === 'frontmatter' ? 'frontmatter' : 'inline',
    line: typeof line === 'number' ? line : 0,
    resolved: resolved === true,
  };
}

export function parseTypedLinkList(value: unknown): TypedLinkList {
  if (!isRecord(value) || !Array.isArray(value.links)) {
    return { links: [], relations: [], truncated: false };
  }
  const links = value.links.flatMap((item) => {
    const link = parseLink(item);
    return link === undefined ? [] : [link];
  });
  const relations = Array.isArray(value.relations)
    ? value.relations.flatMap((item) =>
        isRecord(item) && typeof item.name === 'string' && typeof item.count === 'number'
          ? [{ name: item.name, count: item.count }]
          : [],
      )
    : [];
  return { links, relations, truncated: value.truncated === true };
}

export async function fetchTypedLinks(deps: ApiDeps = {}): Promise<TypedLinkList> {
  return parseTypedLinkList(await gitquireRequest<unknown>('/api/gitquire/typed-links', {}, deps));
}

function group(links: readonly TypedLink[], key: (link: TypedLink) => string) {
  const groups = new Map<string, TypedLink[]>();
  for (const link of links) {
    const name = key(link);
    const list = groups.get(name);
    if (list === undefined) groups.set(name, [link]);
    else list.push(link);
  }
  return groups;
}

export function indexTypedLinks(list: TypedLinkList): TypedLinkIndex {
  const bySource = group(list.links, (link) => link.source);
  const byTarget = group(list.links, (link) => link.target);
  return {
    relations: list.relations,
    between(source, target) {
      const names = (bySource.get(source) ?? [])
        .filter((link) => link.target === target)
        .map((link) => link.relation);
      return [...new Set(names)];
    },
    outgoing: (source) => bySource.get(source) ?? [],
    incoming: (target) => byTarget.get(target) ?? [],
  };
}

export const EMPTY_TYPED_LINKS: TypedLinkIndex = indexTypedLinks({
  links: [],
  relations: [],
  truncated: false,
});

export function relationSuggestions(
  index: TypedLinkIndex,
  existingKeys: Iterable<string>,
): RelationName[] {
  const taken = new Set<string>();
  for (const key of existingKeys) {
    const name = normalizeRelation(key);
    if (name !== undefined) taken.add(name);
  }
  return index.relations.filter((relation) => !taken.has(relation.name));
}

export interface RelationFieldSuggestion extends SchemaField {
  name: string;
  group: 'relation';
  count: number;
}

export function relationFieldSuggestions(
  index: TypedLinkIndex,
  existingKeys: Iterable<string>,
): RelationFieldSuggestion[] {
  return relationSuggestions(index, existingKeys).map((relation) => ({
    name: relation.name,
    type: 'text' as const,
    required: false,
    group: 'relation' as const,
    count: relation.count,
  }));
}

export interface TypedLinkStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TypedLinkIndex;
  refresh: () => Promise<void>;
}

export function createTypedLinkStore(
  load: () => Promise<TypedLinkList> = fetchTypedLinks,
): TypedLinkStore {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_TYPED_LINKS;
  let pending: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    if (pending !== undefined) return pending;
    pending = load()
      .then((list) => {
        snapshot = indexTypedLinks(list);
      })
      .catch(() => {
        snapshot = EMPTY_TYPED_LINKS;
      })
      .finally(() => {
        pending = undefined;
        for (const listener of listeners) listener();
      });
    return pending;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void refresh();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    refresh,
  };
}

const sharedStore = createTypedLinkStore();
let watchers = 0;
let stopWatching: (() => void) | undefined;

function watchChanges(): () => void {
  watchers += 1;
  if (watchers === 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void sharedStore.refresh(), RELOAD_AFTER_CHANGE_MS);
    };
    const stops = [
      subscribeToDocPersisted(later),
      subscribeToDocumentsChanged(later),
      subscribeToBranchChanged(() => void sharedStore.refresh()),
    ];
    stopWatching = () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }
  return () => {
    watchers -= 1;
    if (watchers === 0) {
      stopWatching?.();
      stopWatching = undefined;
    }
  };
}

export function useTypedLinks(): TypedLinkIndex {
  useEffect(watchChanges, []);
  return useSyncExternalStore(
    sharedStore.subscribe,
    sharedStore.getSnapshot,
    () => EMPTY_TYPED_LINKS,
  );
}
