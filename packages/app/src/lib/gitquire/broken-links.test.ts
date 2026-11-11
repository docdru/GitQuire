import { describe, expect, test } from 'vitest';
import {
  badgeCount,
  countBrokenLinks,
  fetchBrokenLinks,
  filterBrokenLinks,
  isTeamPage,
  limitBrokenLinks,
  parseBrokenLinks,
  teamBrokenLinks,
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

  test('reports the list as unavailable only when the server has no link index', async () => {
    const off = { available: false, links: [] };
    const notConfigured = { type: 'urn:ok:error:backlink-index-not-configured' };
    expect(await fetchBrokenLinks(answering(503, notConfigured))).toEqual(off);
    expect(await fetchBrokenLinks(answering(404, {}))).toEqual(off);
    const report = await fetchBrokenLinks(answering(200, body));
    expect(report.available).toBe(true);
    expect(report.links).toHaveLength(2);
    const restarting = { type: 'urn:ok:error:derived-index-unavailable' };
    await expect(fetchBrokenLinks(answering(503, restarting))).rejects.toThrow(/HTTP 503/);
    await expect(fetchBrokenLinks(answering(500, {}))).rejects.toThrow(/HTTP 500/);
  });

  test('keeps team pages and drops agent folders, managed pages and logs', () => {
    const rules = { skipLogPages: true };
    expect(isTeamPage('notes/report', rules)).toBe(true);
    expect(isTeamPage('.claude/skills/review/SKILL', rules)).toBe(false);
    expect(isTeamPage('notes/log', rules)).toBe(false);
    expect(isTeamPage('notes/log', { skipLogPages: false })).toBe(true);
    expect(isTeamPage('notes/catalog', rules)).toBe(true);
    const links = [
      { target: 'A', sources: [{ docName: 'log', title: 'log', snippet: null }] },
      {
        target: 'B',
        sources: [
          { docName: 'plan', title: 'plan', snippet: null },
          { docName: '.agents/x', title: 'x', snippet: null },
        ],
      },
    ];
    expect(teamBrokenLinks(links, rules)).toEqual([
      { target: 'B', sources: [{ docName: 'plan', title: 'plan', snippet: null }] },
    ]);
  });

  test('caps what is listed and says how much is left out', () => {
    const links = parseBrokenLinks(body);
    expect(limitBrokenLinks(links, 10)).toEqual({ links, hidden: 0 });
    const capped = limitBrokenLinks(links, 1);
    expect(capped.hidden).toBe(2);
    expect(capped.links).toEqual([
      { target: 'Roadmap 2027', sources: [{ docName: 'plan', title: 'plan', snippet: null }] },
    ]);
  });

  test('caps the badge', () => {
    expect(badgeCount(7)).toBe('7');
    expect(badgeCount(120)).toBe('99+');
  });
});
