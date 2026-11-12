import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GateLogger, SessionUser } from './access-gate.ts';
import {
  AgentTokenLimitError,
  type AgentTokenRecord,
  type AgentTokenStore,
  cleanLabel,
} from './agent-tokens.ts';
import type { GitHubAuthConfig } from './github-auth-config.ts';
import { escapeHtml, isSameOriginRequest, readForm, redirect, sendHtml } from './http-util.ts';

export const AGENTS_PAGE_PATH = '/auth/agents';

export interface AgentPagesDeps {
  config: Pick<GitHubAuthConfig, 'externalUrl' | 'agentTokenDays' | 'admins'>;
  store: AgentTokenStore;
  log: GateLogger;
  sessionUser: (req: IncomingMessage) => SessionUser | undefined;
  connectorsEnabled: boolean;
  now?: () => number;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function mcpUrl(externalUrl: URL): string {
  return new URL('/mcp', externalUrl).toString();
}

export function claudeCodeCommand(externalUrl: URL, token: string): string {
  const header = `--header "Authorization: Bearer ${token}"`;
  return `claude mcp add --transport http gitquire ${mcpUrl(externalUrl)} ${header}`;
}

export function claudeDesktopConfig(externalUrl: URL, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        gitquire: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            mcpUrl(externalUrl),
            '--header',
            `Authorization: Bearer ${token}`,
          ],
        },
      },
    },
    null,
    2,
  );
}

export function createAgentPages(deps: AgentPagesDeps) {
  const now = deps.now ?? Date.now;
  const isAdmin = (user: SessionUser) => deps.config.admins.has(user.login.toLowerCase());

  function row(record: AgentTokenRecord, showOwner: boolean): string {
    const kind = record.kind === 'connector' ? 'Connector' : 'Token';
    const lastUsed = record.lastUsedAt === undefined ? 'never' : day(record.lastUsedAt);
    const owner = showOwner ? `<td>@${escapeHtml(record.owner.login)}</td>` : '';
    return `<tr>${owner}<td>${escapeHtml(record.label)}<br><span class="muted">${kind}</span></td><td>${day(record.createdAt)}</td><td>${lastUsed}</td><td>${day(record.expiresAt)}</td><td><form method="post" action="${AGENTS_PAGE_PATH}/revoke"><input type="hidden" name="id" value="${escapeHtml(record.id)}"><button type="submit">Revoke</button></form></td></tr>`;
  }

  function table(records: AgentTokenRecord[], showOwner: boolean, empty: string): string {
    if (records.length === 0) return `<p class="muted">${empty}</p>`;
    const ownerHead = showOwner ? '<th>Person</th>' : '';
    const head = `<tr>${ownerHead}<th>Name</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr>`;
    const body = records.map((r) => row(r, showOwner)).join('');
    return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  function page(res: ServerResponse, user: SessionUser, notice: string, status = 200): void {
    const mine = deps.store.list(user.id);
    const others = isAdmin(user)
      ? deps.store.list().filter((record) => record.owner.id !== user.id)
      : [];
    const connectorHelp = deps.connectorsEnabled
      ? `<h2>Claude on the web and on your phone</h2><p>In Claude's settings, add a custom connector with this address, then sign in with GitHub when asked:</p><pre>${escapeHtml(mcpUrl(deps.config.externalUrl))}</pre><p class="muted">Connectors you authorize show up in the list above, and you can revoke them here.</p>`
      : '';
    const adminSection = isAdmin(user)
      ? `<h2>Everyone's agent access</h2><p class="muted">You are an admin, so you can revoke anyone's tokens.</p>${table(others, true, 'Nobody else has agent access.')}`
      : '';
    sendHtml(
      res,
      status,
      'AI agent access',
      `<p>Signed in as <strong>@${escapeHtml(user.login)}</strong>. <a href="/">Back to the wiki</a></p>
<p>An agent token lets your own AI agent, such as Claude Code or the Claude desktop app, read and edit the wiki as you. Its edits are credited to you, and each token can be revoked on its own.</p>
${notice}
<h2>Create a token</h2>
<form method="post" action="${AGENTS_PAGE_PATH}">
<p><label for="label">What is it for?</label><br><input type="text" id="label" name="label" maxlength="80" placeholder="Claude Code on my laptop" required></p>
<p><button type="submit">Create token</button> <span class="muted">Valid for ${deps.config.agentTokenDays} days.</span></p>
</form>
<h2>Your agents</h2>
${table(mine, false, 'You have no agent tokens yet.')}
${connectorHelp}
${adminSection}`,
    );
  }

  function createdNotice(token: string): string {
    const url = deps.config.externalUrl;
    return `<div style="border:2px solid #1a7f37;border-radius:8px;padding:0 1rem;margin:1rem 0">
<p><strong>Your new token.</strong> Copy it now: it is shown only once.</p>
<pre>${escapeHtml(token)}</pre>
<p><strong>Claude Code:</strong> run this in a terminal.</p>
<pre>${escapeHtml(claudeCodeCommand(url, token))}</pre>
<p><strong>Claude desktop app (chat):</strong> open Settings → Developer → Edit Config, add this, then restart the app.</p>
<pre>${escapeHtml(claudeDesktopConfig(url, token))}</pre>
<p class="muted">Other agents: use the MCP address <code>${escapeHtml(mcpUrl(url))}</code> with the header <code>Authorization: Bearer &lt;token&gt;</code>.</p>
</div>`;
  }

  async function handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    user: SessionUser,
  ): Promise<void> {
    if (!isSameOriginRequest(req, deps.config.externalUrl)) {
      sendHtml(res, 403, 'Not allowed', '<p>This form must be sent from the wiki itself.</p>');
      return;
    }
    const form = await readForm(req);
    if (path === `${AGENTS_PAGE_PATH}/revoke`) {
      const id = form.get('id') ?? '';
      const ok = deps.store.revoke(id, isAdmin(user) ? 'admin' : { ownerId: user.id });
      page(
        res,
        user,
        ok
          ? '<p><strong>Revoked.</strong> That agent can no longer reach the wiki.</p>'
          : '<p><strong>Nothing revoked.</strong> The token was already gone.</p>',
      );
      return;
    }
    try {
      const { token } = deps.store.createPersonal(
        { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl },
        cleanLabel(form.get('label'), `Agent token ${day(now())}`),
        deps.config.agentTokenDays,
      );
      page(res, user, createdNotice(token));
    } catch (err) {
      if (err instanceof AgentTokenLimitError) {
        page(res, user, `<p><strong>${escapeHtml(err.message)}</strong></p>`, 409);
        return;
      }
      throw err;
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (path !== AGENTS_PAGE_PATH && path !== `${AGENTS_PAGE_PATH}/revoke`) return false;
    const user = deps.sessionUser(req);
    if (user === undefined) {
      redirect(res, `/auth/github/login?next=${encodeURIComponent(AGENTS_PAGE_PATH)}`);
      return true;
    }
    if (req.method === 'POST') {
      handlePost(req, res, path, user).catch((err: unknown) => {
        deps.log.error({ err }, '[gitquire-agents] agent page request failed');
        if (!res.headersSent) {
          sendHtml(res, 500, 'Something went wrong', '<p>Try again in a moment.</p>');
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      return true;
    }
    if (path !== AGENTS_PAGE_PATH) {
      redirect(res, AGENTS_PAGE_PATH);
      return true;
    }
    page(res, user, '');
    return true;
  }

  return { handle };
}
