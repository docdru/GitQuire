import { describe, expect, test } from 'vitest';
import {
  createTypedLinkStore,
  EMPTY_TYPED_LINKS,
  fetchTypedLinks,
  indexTypedLinks,
  parseTypedLinkList,
  relationFieldSuggestions,
  relationSuggestions,
  type TypedLink,
} from './typed-links';

function link(source: string, target: string, relation: string): TypedLink {
  return { source, target, anchor: null, relation, origin: 'inline', line: 0, resolved: true };
}

const LIST = {
  links: [
    link('decision-14', 'decision-9', 'supersedes'),
    link('decision-14', 'decision-9', 'supersedes'),
    link('decision-14', 'decision-9', 'relates to'),
    link('task-a', 'task-b', 'blocks'),
  ],
  relations: [
    { name: 'supersedes', count: 2 },
    { name: 'blocks', count: 1 },
    { name: 'relates to', count: 1 },
  ],
  truncated: false,
};

describe('parseTypedLinkList', () => {
  test('keeps well-formed links and drops the rest', () => {
    const parsed = parseTypedLinkList({
      links: [{ source: 'a', target: 'b', relation: 'blocks', origin: 'frontmatter' }, { x: 1 }],
      relations: [{ name: 'blocks', count: 1 }, 'junk'],
    });
    expect(parsed.links).toEqual([
      {
        source: 'a',
        target: 'b',
        anchor: null,
        relation: 'blocks',
        origin: 'frontmatter',
        line: 0,
        resolved: false,
      },
    ]);
    expect(parsed.relations).toEqual([{ name: 'blocks', count: 1 }]);
  });

  test('treats an unexpected body as no typed links', () => {
    expect(parseTypedLinkList(null).links).toEqual([]);
    expect(parseTypedLinkList({ nodes: [] }).links).toEqual([]);
  });
});

describe('indexTypedLinks', () => {
  test('answers relations between two pages, outgoing and incoming', () => {
    const index = indexTypedLinks(LIST);
    expect(index.between('decision-14', 'decision-9')).toEqual(['supersedes', 'relates to']);
    expect(index.between('decision-9', 'decision-14')).toEqual([]);
    expect(index.outgoing('task-a').map((entry) => entry.target)).toEqual(['task-b']);
    expect(index.incoming('decision-9')).toHaveLength(3);
    expect(EMPTY_TYPED_LINKS.between('a', 'b')).toEqual([]);
  });
});

describe('relationSuggestions', () => {
  test('offers relation names the page does not use yet', () => {
    const index = indexTypedLinks(LIST);
    expect(relationSuggestions(index, ['Supersedes', 'title']).map((entry) => entry.name)).toEqual([
      'blocks',
      'relates to',
    ]);
    expect(relationFieldSuggestions(index, ['blocks', 'relates to'])).toEqual([
      { name: 'supersedes', type: 'text', required: false, group: 'relation', count: 2 },
    ]);
  });
});

describe('fetchTypedLinks', () => {
  test('reads the server list', async () => {
    const fetch = async () => new Response(JSON.stringify(LIST), { status: 200 });
    const list = await fetchTypedLinks({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(list.links).toHaveLength(4);
  });
});

describe('createTypedLinkStore', () => {
  test('loads on the first subscriber and falls back to empty on errors', async () => {
    let calls = 0;
    const store = createTypedLinkStore(async () => {
      calls += 1;
      if (calls > 1) throw new Error('offline');
      return LIST;
    });
    let notified = 0;
    const stop = store.subscribe(() => {
      notified += 1;
    });
    await store.refresh();
    expect(calls).toBe(1);
    expect(notified).toBe(1);
    expect(store.getSnapshot().between('task-a', 'task-b')).toEqual(['blocks']);
    await store.refresh();
    expect(store.getSnapshot()).toBe(EMPTY_TYPED_LINKS);
    stop();
  });
});
