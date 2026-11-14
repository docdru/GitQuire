import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  isPagePath,
  isSlug,
  parseNameStatus,
  readCookie,
  servedByLive,
  slugify,
  uniqueSlug,
  viewCookie,
} from './model.ts';

describe('draft names', () => {
  it('turns a title into a short slug', () => {
    expect(slugify('Kick-off notes: Q4 / Zürich')).toBe('kick-off-notes-q4-zurich');
    expect(slugify('!!!')).toBe('draft');
    expect(slugify('a'.repeat(80))).toHaveLength(48);
  });

  it('adds a number when the slug is taken', () => {
    const taken = new Set(['plan', 'plan-2']);
    expect(uniqueSlug('Plan', (slug) => taken.has(slug))).toBe('plan-3');
  });

  it('accepts only clean titles and slugs', () => {
    expect(cleanTitle('  Two   words ')).toBe('Two words');
    expect(cleanTitle('')).toBeUndefined();
    expect(cleanTitle('x'.repeat(121))).toBeUndefined();
    expect(isSlug('kick-off')).toBe(true);
    expect(isSlug('../etc')).toBe(false);
    expect(isSlug('Upper')).toBe(false);
  });
});

describe('view cookie', () => {
  it('reads the view cookie among others', () => {
    expect(readCookie('a=1; gq_view=plan; b=2', 'gq_view')).toBe('plan');
    expect(readCookie('a=1', 'gq_view')).toBeUndefined();
    expect(readCookie(undefined, 'gq_view')).toBeUndefined();
  });

  it('sets and clears the cookie', () => {
    expect(viewCookie('plan', true)).toBe(
      'gq_view=plan; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure',
    );
    expect(viewCookie(null, false)).toBe('gq_view=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');
  });
});

describe('servedByLive', () => {
  it('keeps sign-in, agents, drafts and personal data on the live server', () => {
    for (const path of [
      '/auth/me',
      '/mcp',
      '/.well-known/oauth-protected-resource/mcp',
      '/api/gitquire/drafts',
      '/api/gitquire/drafts/plan/publish',
      '/api/gitquire/view',
      '/api/gitquire/mentions',
      '/api/gitquire/me/settings',
      '/healthz',
    ]) {
      expect(servedByLive(path), path).toBe(true);
    }
  });

  it('sends pages, content APIs and assets to the draft', () => {
    for (const path of [
      '/',
      '/api/documents',
      '/collab',
      '/assets/app.js',
      '/api/gitquire/objects',
    ]) {
      expect(servedByLive(path), path).toBe(false);
    }
  });
});

describe('changed pages', () => {
  it('parses git name-status output', () => {
    expect(parseNameStatus('M\ta.md\nA\tb/c.md\nD\told.md\nR100\tx.md\ty.md\n')).toEqual([
      { path: 'a.md', change: 'modified' },
      { path: 'b/c.md', change: 'added' },
      { path: 'old.md', change: 'deleted' },
      { path: 'x.md', change: 'deleted' },
      { path: 'y.md', change: 'added' },
    ]);
  });

  it('ignores hidden and tool files', () => {
    expect(isPagePath('notes/a.md')).toBe(true);
    expect(isPagePath('.ok/config.yml')).toBe(false);
    expect(isPagePath('.claude/skills/x.md')).toBe(false);
    expect(isPagePath('notes/.draft.md')).toBe(false);
    expect(isPagePath('../etc/passwd')).toBe(false);
    expect(isPagePath('/etc/passwd')).toBe(false);
    expect(isPagePath('a//b.md')).toBe(false);
  });
});
