import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  parseWikiAddress,
  refererAddress,
  stripBrowserHeaders,
  translateResponseHeaders,
  withPrefix,
} from './translate.ts';

function req(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('address translation', () => {
  it('splits /w/<owner>/<repo> from the rest of the address', () => {
    expect(parseWikiAddress('/w/team/wiki/api/x?y=1')).toEqual({
      owner: 'team',
      name: 'wiki',
      rest: '/api/x',
      search: '?y=1',
    });
    expect(parseWikiAddress('/w/team/wiki')).toEqual({
      owner: 'team',
      name: 'wiki',
      rest: '',
      search: '',
    });
    expect(parseWikiAddress('/w/team/.github/')).toMatchObject({ name: '.github', rest: '/' });
    expect(parseWikiAddress('/w/team')).toBeUndefined();
    expect(parseWikiAddress('/w/../wiki/')).toBeUndefined();
    expect(parseWikiAddress('/w/te%61m/wiki/')).toBeUndefined();
    expect(parseWikiAddress('/docs/plan')).toBeUndefined();
  });

  it('adds the prefix to local redirects once', () => {
    expect(withPrefix('/page', '/w/t/w')).toBe('/w/t/w/page');
    expect(withPrefix('/w/t/w/page', '/w/t/w')).toBe('/w/t/w/page');
    expect(withPrefix('/w/t/w', '/w/t/w')).toBe('/w/t/w');
    expect(withPrefix('//evil.example', '/w/t/w')).toBe('//evil.example');
    expect(withPrefix('https://github.com/x', '/w/t/w')).toBe('https://github.com/x');
  });

  it('removes x-gitquire-* headers and the front door cookies a browser sends', () => {
    const r = req({
      'x-gitquire-internal': 'forged',
      'x-gitquire-principal': 'forged',
      'X-GitQuire-Prefix': '/w/other/wiki',
      cookie: 'gq_session=abc; theme=dark; gq_view_github-1=d1; gq_oauth_state=s',
      accept: 'text/html',
    });
    stripBrowserHeaders(r);
    expect(r.headers).toEqual({ cookie: 'theme=dark', accept: 'text/html' });
    const only = req({ cookie: 'gq_session=abc' });
    stripBrowserHeaders(only);
    expect(only.headers.cookie).toBeUndefined();
  });

  it('turns the open draft header into a per-wiki cookie at the root and drops cookies of the editor', () => {
    const out = translateResponseHeaders(
      {
        location: '/?draft=x',
        'x-gitquire-view': 'my-draft',
        'set-cookie': ['gq_view=my-draft; Path=/'],
        'content-type': 'text/html',
      },
      { prefix: '/w/team/wiki', key: 'github-1', secure: true },
    );
    expect(out.location).toBe('/w/team/wiki/?draft=x');
    expect(out['x-gitquire-view']).toBeUndefined();
    expect(out['set-cookie']).toEqual([
      expect.stringMatching(
        /^gq_view_github-1=my-draft; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
      ),
    ]);
    const cleared = translateResponseHeaders(
      { 'x-gitquire-view': '' },
      { prefix: '/w/team/wiki', key: 'github-1', secure: false },
    );
    expect(cleared['set-cookie']).toEqual([
      expect.stringContaining('gq_view_github-1=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'),
    ]);
  });

  it('reads the wiki from a same-origin Referer only', () => {
    expect(
      refererAddress(req({ referer: 'https://w.example/w/team/wiki/page' }), 'https://w.example'),
    ).toMatchObject({ owner: 'team', name: 'wiki' });
    expect(
      refererAddress(req({ referer: 'https://evil.example/w/team/wiki/' }), 'https://w.example'),
    ).toBeUndefined();
    expect(refererAddress(req({}), 'https://w.example')).toBeUndefined();
  });
});
