import { describe, expect, test } from 'vitest';
import {
  countBrokenLinks,
  fetchBrokenLinks,
  filterBrokenLinks,
  parseBrokenLinks,
} from './broken-links';

const body = {
  deadLinks: [
    {
      target: 'Budget',
      sources: [{ source: 'notes/report', title: 'Quarterly report', snippet: 'see [[Budget]]' }],
    },
    {
      target: 'Roadmap 2027',
      sources: [
        { source: 'plan', title: '', snippet: null },
        { source: 'notes/report', title: 'Quarterly report', snippet: '' },
        { source: '', title: 'broken entry', snippet: null },
      ],
    },
    { target: 'No sources', sources: [] },
    { target: 42, sources: [] },
  ],
};

function answering(status: number, payload: unknown) {
  return { fetch: (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch };
}

describe('broken links', () => {
  test('reads the report, most-linked target first, skipping damaged entries', () => {
    expect(parseBrokenLinks(body)).toEqual([
      {
        target: 'Roadmap 2027',
        sources: [
          { docName: 'plan', title: 'plan', snippet: null },
          { docName: 'notes/report', title: 'Quarterly report', snippet: null },
        ],
      },
      {
        target: 'Budget',
        sources: [
          { docName: 'notes/report', title: 'Quarterly report', snippet: 'see [[Budget]]' },
        ],
      },
    ]);
    expect(parseBrokenLinks({ nothing: true })).toEqual([]);
    expect(parseBrokenLinks(null)).toEqual([]);
  });

  test('counts links, not targets', () => {
    expect(countBrokenLinks(parseBrokenLinks(body))).toBe(3);
  });

  test('filters by missing page or by the page that links to it', () => {
    const links = parseBrokenLinks(body);
    expect(filterBrokenLinks(links, 'budget').map((link) => link.target)).toEqual(['Budget']);
    const byPage = filterBrokenLinks(links, 'PLAN');
    expect(byPage).toEqual([
      { target: 'Roadmap 2027', sources: [{ docName: 'plan', title: 'plan', snippet: null }] },
    ]);
    expect(filterBrokenLinks(links, '  ')).toHaveLength(2);
  });

  test('reports the list as unavailable when the server has no link index', async () => {
    expect(await fetchBrokenLinks(answering(503, {}))).toEqual({ available: false, links: [] });
    const report = await fetchBrokenLinks(answering(200, body));
    expect(report.available).toBe(true);
    expect(report.links).toHaveLength(2);
    await expect(fetchBrokenLinks(answering(500, {}))).rejects.toThrow(/HTTP 500/);
  });
});
