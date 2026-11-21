import { describe, expect, it } from 'vitest';
import { scopedStorageKey } from '@/lib/storage-scope';
import { prefixFromPath, wikiStorageNamespace, withWikiPrefix } from './wiki-prefix';

describe('the wiki prefix', () => {
  it('is empty for a wiki served at the root, as today', () => {
    expect(prefixFromPath('/')).toBe('');
    expect(prefixFromPath('/index.html')).toBe('');
    expect(prefixFromPath('/notes')).toBe('');
  });

  it('is the folder the app was loaded from', () => {
    expect(prefixFromPath('/w/team/wiki/')).toBe('/w/team/wiki');
    expect(prefixFromPath('/w/team/wiki/index.html')).toBe('/w/team/wiki');
    expect(prefixFromPath('/w/team/my.wiki/')).toBe('/w/team/my.wiki');
  });

  it('ignores a folder that is not a plain path', () => {
    expect(prefixFromPath('/w/../x/')).toBe('');
    expect(prefixFromPath('/w/a%20b/')).toBe('');
    expect(prefixFromPath('//evil.example/')).toBe('');
  });
});

describe('withWikiPrefix', () => {
  it('leaves every address alone without a prefix', () => {
    expect(withWikiPrefix('/api/asset?path=a.png', '')).toBe('/api/asset?path=a.png');
  });

  it('puts the prefix in front of root addresses once', () => {
    expect(withWikiPrefix('/api/asset?path=a.png', '/w/team/wiki')).toBe(
      '/w/team/wiki/api/asset?path=a.png',
    );
    expect(withWikiPrefix('/w/team/wiki/api/x', '/w/team/wiki')).toBe('/w/team/wiki/api/x');
    expect(withWikiPrefix('/w/team/wiki-b/api/x', '/w/team/wiki')).toBe(
      '/w/team/wiki/w/team/wiki-b/api/x',
    );
  });

  it('leaves relative, protocol-relative and absolute addresses alone', () => {
    expect(withWikiPrefix('api/x', '/w/team/wiki')).toBe('api/x');
    expect(withWikiPrefix('//cdn.example/x', '/w/team/wiki')).toBe('//cdn.example/x');
    expect(withWikiPrefix('https://example.com/x', '/w/team/wiki')).toBe('https://example.com/x');
  });
});

describe('the storage namespace', () => {
  it('is none at the root, so every key stays as today', () => {
    expect(wikiStorageNamespace('')).toBeNull();
    expect(scopedStorageKey('ok-last-observed-branch', wikiStorageNamespace(''))).toBe(
      'ok-last-observed-branch',
    );
  });

  it('differs per wiki, so two wikis on one origin keep their own keys', () => {
    const a = scopedStorageKey('ok-doc-lineage-epochs', wikiStorageNamespace('/w/team/a'));
    const b = scopedStorageKey('ok-doc-lineage-epochs', wikiStorageNamespace('/w/team/b'));
    expect(a).not.toBe('ok-doc-lineage-epochs');
    expect(a).not.toBe(b);
  });
});
