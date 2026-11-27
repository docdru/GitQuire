import { createServer, type Server } from 'node:http';
import { escapeHtml, sendHtml, sendJson } from '../http-util.ts';
import type { FrontDoorSetupNeeded } from './settings.ts';

const KINDS = ['github', 'forgejo'] as const;

function callbackFor(externalUrl: URL | undefined, key: string): string {
  const origin = externalUrl === undefined ? '<GITQUIRE_EXTERNAL_URL>' : externalUrl.origin;
  return `${origin}/auth/${key}/callback`;
}

function hostSteps(key: string, externalUrl: URL | undefined): string {
  const name = `GITQUIRE_HOST_${key.toUpperCase().replaceAll('-', '_')}`;
  const callback = escapeHtml(callbackFor(externalUrl, key));
  const githubLike = key === 'github';
  const forgejoLike = key === 'forgejo';
  const parts: string[] = [];
  if (!forgejoLike) {
    parts.push(
      `<p><strong>On GitHub</strong> (key <code>${escapeHtml(key)}</code>): create a GitHub App with the callback address <code>${callback}</code>, the repository permissions Contents and Pull requests (read and write), Metadata (read), and the account permission Email addresses (read). Install it on the owners whose repositories become wikis. Then set <code>${name}_CLIENT_ID</code>, <code>${name}_CLIENT_SECRET</code>, <code>${name}_APP_ID</code>, <code>${name}_APP_PRIVATE_KEY_FILE</code> and <code>${name}_ALLOWED_OWNERS</code>${githubLike ? '' : `, and <code>${name}_KIND=github</code>`}.</p>`,
    );
  }
  if (!githubLike) {
    parts.push(
      `<p><strong>On Forgejo</strong> (key <code>${escapeHtml(key)}</code>): create an OAuth2 application with the redirect address <code>${callback}</code>, and a bot account with an unlimited token. Then set <code>${name}_URL</code>, <code>${name}_CLIENT_ID</code>, <code>${name}_CLIENT_SECRET</code>, <code>${name}_TOKEN</code> and <code>${name}_ALLOWED_OWNERS</code>${forgejoLike ? '' : `, and <code>${name}_KIND=forgejo</code>`}.</p>`,
    );
  }
  return parts.join('');
}

export function setupPageBody(needed: FrontDoorSetupNeeded): string {
  const missing = needed.missing
    .map((name) => `<li><code>${escapeHtml(name)}</code></li>`)
    .join('');
  const keys = needed.hostKeys.length > 0 ? needed.hostKeys : KINDS;
  const intro =
    needed.hostKeys.length > 0
      ? ''
      : '<p>List the Git hosts in <code>GITQUIRE_HOSTS</code>, separated by commas, for example <code>GITQUIRE_HOSTS=github</code> or <code>GITQUIRE_HOSTS=github,forgejo</code>. Each host is described by <code>GITQUIRE_HOST_&lt;KEY&gt;_…</code>.</p>';
  return [
    '<p>GitQuire is running, but it is not set up yet. Set these in its environment and start it again:</p>',
    `<ul>${missing}</ul>`,
    '<p><code>GITQUIRE_EXTERNAL_URL</code> is the address people open, without a path. <code>GITQUIRE_SESSION_SECRET</code> is at least 32 characters, for example from <code>openssl rand -hex 32</code>.</p>',
    intro,
    ...keys.map((key) => hostSteps(key, needed.externalUrl)),
    '<p class="muted">Then sign in and choose <strong>Add a wiki</strong>. The steps are in DEPLOY.md, "Quick start".</p>',
  ].join('');
}

export function createSetupServer(needed: FrontDoorSetupNeeded): Server {
  const body = setupPageBody(needed);
  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/readyz') {
      sendJson(res, 503, { ready: false, reason: 'setup' });
      return;
    }
    sendHtml(res, 503, 'Set up GitQuire', body);
  });
}
