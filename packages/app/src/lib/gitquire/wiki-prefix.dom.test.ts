import { afterEach, describe, expect, it } from 'vitest';
import { defaultCollabWsUrl } from '@/lib/cc1';
import { wikiPrefix, wikiStorageNamespace } from './wiki-prefix';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the wiki prefix in the browser', () => {
  it('is empty at the root, and the live-editing fallback address is as today', () => {
    window.history.replaceState(null, '', '/');
    expect(wikiPrefix()).toBe('');
    expect(wikiStorageNamespace()).toBeNull();
    expect(defaultCollabWsUrl()).toBe(`ws://${window.location.host}/collab`);
  });

  it('comes from the folder the page was loaded from', () => {
    window.history.replaceState(null, '', '/w/team/wiki/#/notes/plan');
    expect(wikiPrefix()).toBe('/w/team/wiki');
    expect(wikiStorageNamespace()).toBe('wiki:/w/team/wiki');
    expect(defaultCollabWsUrl()).toBe(`ws://${window.location.host}/w/team/wiki/collab`);
  });
});
