import { describe, expect, test } from 'vitest';
import {
  isManagedArtifactDocName,
  parseLegacyTemplateDocName,
  parseTemplateContentDocName,
  templateContentDocName,
} from './cc1.ts';

describe('isManagedArtifactDocName — __template__ tombstone', () => {
  test('but the prefix still classifies as a managed-artifact name (tombstone)', () => {
    expect(isManagedArtifactDocName('__template__/note')).toBe(true);
    expect(isManagedArtifactDocName('__template__/docs/note')).toBe(true);
  });

  test('a template content name is NOT a managed-artifact name', () => {
    expect(isManagedArtifactDocName('docs/.gitquire/templates/note')).toBe(false);
  });
});

describe('templateContentDocName', () => {
  test('builds a root template content doc name (ext-less, raw)', () => {
    expect(templateContentDocName('', 'daily')).toBe('.gitquire/templates/daily');
  });

  test('builds a single-level folder template content doc name', () => {
    expect(templateContentDocName('docs', 'daily')).toBe('docs/.gitquire/templates/daily');
  });

  test('builds a nested-folder template content doc name', () => {
    expect(templateContentDocName('a/b', 'daily')).toBe('a/b/.gitquire/templates/daily');
  });

  test('normalizes leading/trailing slashes on the folder', () => {
    expect(templateContentDocName('/docs/', 'daily')).toBe('docs/.gitquire/templates/daily');
  });

  test('keeps a spaced folder RAW — no percent-encoding', () => {
    expect(templateContentDocName('My Notes', 'daily')).toBe('My Notes/.gitquire/templates/daily');
  });
});

describe('parseTemplateContentDocName', () => {
  test('parses a root template leaf', () => {
    expect(parseTemplateContentDocName('.gitquire/templates/daily')).toEqual({
      folder: '',
      name: 'daily',
    });
  });

  test('parses a template leaf under a folder, preserving the folder segment', () => {
    expect(parseTemplateContentDocName('docs/.gitquire/templates/daily')).toEqual({
      folder: 'docs',
      name: 'daily',
    });
    expect(parseTemplateContentDocName('a/b/.gitquire/templates/daily')).toEqual({
      folder: 'a/b',
      name: 'daily',
    });
  });

  test('returns null for a subdirectory under .gitquire/templates — templates are single leaves', () => {
    expect(parseTemplateContentDocName('.gitquire/templates/sub/daily')).toBeNull();
    expect(parseTemplateContentDocName('docs/.gitquire/templates/sub/daily')).toBeNull();
  });

  test('returns null for a non-template .gitquire path', () => {
    expect(parseTemplateContentDocName('.gitquire/skills/demo/SKILL')).toBeNull();
    expect(parseTemplateContentDocName('.gitquire/config.yml')).toBeNull();
  });

  test('returns null for an ordinary content doc name', () => {
    expect(parseTemplateContentDocName('docs/getting-started')).toBeNull();
    expect(parseTemplateContentDocName('readme')).toBeNull();
    expect(parseTemplateContentDocName('')).toBeNull();
  });

  test('strips a `.md` suffix but no other extension — a template IS a `.md` leaf', () => {
    expect(parseTemplateContentDocName('.gitquire/templates/daily.md')).toEqual({
      folder: '',
      name: 'daily',
    });
    expect(parseTemplateContentDocName('docs/.gitquire/templates/daily.mdx')).toEqual({
      folder: 'docs',
      name: 'daily.mdx',
    });
  });

  test('parses by SHAPE only — a name that would fail the template-name grammar still parses', () => {
    expect(parseTemplateContentDocName('.gitquire/templates/Has Spaces')).toEqual({
      folder: '',
      name: 'Has Spaces',
    });
    expect(parseTemplateContentDocName('docs/.gitquire/templates/UPPER_case!')).toEqual({
      folder: 'docs',
      name: 'UPPER_case!',
    });
  });
});

describe('parseLegacyTemplateDocName', () => {
  test('parses a stale synthetic root template name', () => {
    expect(parseLegacyTemplateDocName('__template__/daily')).toEqual({ folder: '', name: 'daily' });
  });

  test('parses a stale synthetic name under a folder (flat and nested)', () => {
    expect(parseLegacyTemplateDocName('__template__/docs/daily')).toEqual({
      folder: 'docs',
      name: 'daily',
    });
    expect(parseLegacyTemplateDocName('__template__/a/b/daily')).toEqual({
      folder: 'a/b',
      name: 'daily',
    });
  });

  test('percent-DECODES each segment so an encoded stale name maps to the raw folder/name', () => {
    expect(parseLegacyTemplateDocName('__template__/My%20Notes/daily')).toEqual({
      folder: 'My Notes',
      name: 'daily',
    });
  });

  test('returns null for a content-shaped name and other non-synthetic names', () => {
    expect(parseLegacyTemplateDocName('docs/.gitquire/templates/daily')).toBeNull();
    expect(parseLegacyTemplateDocName('docs/getting-started')).toBeNull();
    expect(parseLegacyTemplateDocName('__skill__/global/demo')).toBeNull();
    expect(parseLegacyTemplateDocName('__template__/')).toBeNull();
    expect(parseLegacyTemplateDocName('')).toBeNull();
  });
});

describe('template content name round-trips (build → parse)', () => {
  test.each([
    { label: 'root', folder: '', name: 'daily' },
    { label: 'single-level folder', folder: 'docs', name: 'daily' },
    { label: 'nested folder', folder: 'a/b', name: 'daily' },
    { label: 'spaced folder', folder: 'My Notes', name: 'daily' },
  ])('round-trips a $label', ({ folder, name }) => {
    expect(parseTemplateContentDocName(templateContentDocName(folder, name))).toEqual({
      folder,
      name,
    });
  });
});
