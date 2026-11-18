import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { sendHtml } from './http-util.ts';

function capture(): { res: ServerResponse; html: () => string } {
  let body = '';
  const res = {
    writeHead: () => res,
    end: (chunk: string) => {
      body = chunk;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, html: () => body };
}

describe('server pages', () => {
  it('link the app manifest and home-screen icons, so installing from the sign-in page keeps the icon', () => {
    const page = capture();
    sendHtml(page.res, 200, 'Sign in', '<p>Hi</p>');
    expect(page.html()).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(page.html()).toContain('<link rel="apple-touch-icon" href="/icons/gitquire-180.png">');
  });
});
