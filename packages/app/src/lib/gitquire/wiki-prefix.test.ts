import { describe, expect, it } from 'vitest';
import { scopedStorageKey } from '@/lib/storage-scope';
import { prefixFromPath, wikiStorageNamespace, withWikiPrefix } from './wiki-prefix';

describe('the wiki prefix', () => {
  it('is empty outside the /w/<owner>/<repo>/ address scheme, as today', () => {
    expect(prefixFromPath('/')).toBe('');
    expect(prefixFromPath('/index.html')).toBe('');
    expect(prefixFromPath('/notes')).toBe('');
    expect(prefixFromPath('/docs/plan')).toBe('');
    expect(prefixFromPath('/something/page/')).toBe('');
    expect(prefixFromPath('/gitquire/')).toBe('');
  });

  it('is /w/<host>/<owner>/<repo> when the page is under that address', () => {
    expect(prefixFromPath('/w/github/team/wiki/')).toBe('/w/github/team/wiki');
    expect(prefixFromPath('/w/forgejo/team/wiki/x')).toBe('/w/forgejo/team/wiki');
    expect(prefixFromPath('/w/lab-2/team/wiki/index.html')).toBe('/w/lab-2/team/wiki');
    expect(prefixFromPath('/w/github/team/my.wiki/')).toBe('/w/github/team/my.wiki');
  });

  it('needs the host, the owner, the repo and the slash after them', () => {
    expect(prefixFromPath('/w/github/team')).toBe('');
    expect(prefixFromPath('/w/github/team/')).toBe('');
    expect(prefixFromPath('/w/github/team/wiki')).toBe('');
    expect(prefixFromPath('/w/team/wiki/')).toBe('');
    expect(prefixFromPath('/x/w/github/team/wiki/')).toBe('');
  });

  it('ignores hosts, owners and repos that are not plain names', () => {
    expect(prefixFromPath('/w/github/team/../')).toBe('');
    expect(prefixFromPath('/w/github/team/./')).toBe('');
    expect(prefixFromPath('/w/github/a%20b/wiki/')).toBe('');
    expect(prefixFromPath('/w/github/te.am/wiki/')).toBe('');
    expect(prefixFromPath('/w/GitHub/team/wiki/')).toBe('');
  });
});

describe('withWikiPrefix', () => {
  it('leaves every address alone without a prefix', () => {
    expect(withWikiPrefix('/api/asset?path=a.png', '')).toBe('/api/asset?path=a.png');
  });

  it('puts the prefix in front of root addresses once', () => {
    expect(withWikiPrefix('/api/asset?path=a.png', '/w/github/team/wiki')).toBe(
      '/w/github/team/wiki/api/asset?path=a.png',
    );
    expect(withWikiPrefix('/w/github/team/wiki/api/x', '/w/github/team/wiki')).toBe(
      '/w/github/team/wiki/api/x',
    );
    expect(withWikiPrefix('/w/github/team/wiki-b/api/x', '/w/github/team/wiki')).toBe(
      '/w/github/team/wiki/w/github/team/wiki-b/api/x',
    );
  });

  it("leaves the front door's own API at the root", () => {
    expect(withWikiPrefix('/api/front-door/wikis', '/w/github/team/wiki')).toBe(
      '/api/front-door/wikis',
    );
    expect(withWikiPrefix('/api/front-doors', '/w/github/team/wiki')).toBe(
      '/w/github/team/wiki/api/front-doors',
    );
  });

  it('leaves relative, protocol-relative and absolute addresses alone', () => {
    expect(withWikiPrefix('api/x', '/w/github/team/wiki')).toBe('api/x');
    expect(withWikiPrefix('//cdn.example/x', '/w/github/team/wiki')).toBe('//cdn.example/x');
    expect(withWikiPrefix('https://example.com/x', '/w/github/team/wiki')).toBe(
      'https://example.com/x',
    );
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
