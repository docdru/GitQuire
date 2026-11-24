import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_TTL_MS } from './access.ts';
import { cleanUpRigs, httpFetch, type TwoHostRig, twoHostRig } from './two-hosts.test-helper.ts';

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await cleanUpRigs();
});

function tokenOn(rig: TwoHostRig, hostKey: 'github' | 'forgejo', who: string): string {
  const store = rig.agents?.storeOf(hostKey);
  const person = rig.hosts[hostKey].people[who];
  if (store === undefined || person === undefined) throw new Error('no store or person');
  return store.createPersonal(person, 'test', 30).token;
}

async function connect(rig: TwoHostRig, path: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${rig.base}${path}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-agent', version: '1' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? '').join('\n');
}

async function listedNames(client: Client): Promise<string[]> {
  const listed = await client.callTool({ name: 'list_wikis', arguments: {} });
  return [...new Set(textOf(listed).match(/\b(?:github|forgejo)\/team\/[a-z]+\b/g) ?? [])].sort();
}

describe('AI agents with two Git hosts', () => {
  it('keeps the agent tokens of the same id on two hosts apart', async () => {
    const rig = await twoHostRig({ agents: true });
    const onGitHub = tokenOn(rig, 'github', 'alice');
    const onForgejo = tokenOn(rig, 'forgejo', 'alice');

    expect(await listedNames(await connect(rig, '/mcp/github', onGitHub))).toEqual([
      'github/team/a',
      'github/team/g',
    ]);
    expect(await listedNames(await connect(rig, '/mcp/forgejo', onForgejo))).toEqual([
      'forgejo/team/a',
      'forgejo/team/f',
    ]);

    const crossed = await httpFetch(`${rig.base}/mcp/forgejo`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${onGitHub}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(crossed.status).toBe(401);
    const back = await httpFetch(`${rig.base}/mcp/github`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${onForgejo}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(back.status).toBe(401);
  });

  it('does not let a Forgejo token name a GitHub wiki', async () => {
    const rig = await twoHostRig({ agents: true });
    const client = await connect(rig, '/mcp/forgejo', tokenOn(rig, 'forgejo', 'alice'));
    const refused = await client.callTool({
      name: 'read',
      arguments: { wiki: 'github/team/g', path: 'index.md' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('github/team/g');
    expect(textOf(refused)).toContain('list_wikis');
    const short = await client.callTool({
      name: 'read',
      arguments: { wiki: 'team/f', path: 'index.md' },
    });
    expect(short.isError).toBe(true);
    expect(textOf(short)).toContain('list_wikis');
  });

  it('stores the tokens of each host in a file of its own, named by the host key', async () => {
    const rig = await twoHostRig({ agents: true });
    tokenOn(rig, 'github', 'alice');
    tokenOn(rig, 'forgejo', 'carol');
    rig.agents?.storeOf('github')?.flush();
    rig.agents?.storeOf('forgejo')?.flush();
    expect(existsSync(join(rig.data, 'server', 'agent-tokens-github.json'))).toBe(true);
    expect(existsSync(join(rig.data, 'server', 'agent-tokens.json'))).toBe(false);
    expect(existsSync(join(rig.data, 'server', 'agent-tokens-forgejo.json'))).toBe(true);
    expect(
      rig.agents
        ?.storeOf('github')
        ?.list()
        .map((r) => r.owner.login),
    ).toEqual(['alice']);
    expect(
      rig.agents
        ?.storeOf('forgejo')
        ?.list()
        .map((r) => r.owner.login),
    ).toEqual(['carol']);
  });

  it('revokes only the tokens of the host where access was lost', async () => {
    const rig = await twoHostRig({ agents: true });
    tokenOn(rig, 'github', 'alice');
    tokenOn(rig, 'forgejo', 'alice');
    rig.hosts.forgejo.levels.alice = {};
    rig.advance(ACCESS_TTL_MS + 1);
    expect(await rig.agents?.sweep.runOnce()).toBe(1);
    expect(rig.agents?.storeOf('github')?.list()).toHaveLength(1);
    expect(rig.agents?.storeOf('forgejo')?.list()).toHaveLength(0);
  });

  it('serves an agents page per host, signed in with that host', async () => {
    const rig = await twoHostRig({ agents: true });
    const forgejo = await rig.signIn('forgejo', 'carol');
    const page = await rig.get('/auth/forgejo/agents', forgejo);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('@carol');
    expect(html).toContain('on Forgejo');
    expect(html).toContain('action="/auth/forgejo/agents"');
    expect(html).toContain('href="/auth/github/agents"');
    const first = await rig.get('/auth/github/agents', forgejo);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toContain('/auth/github/login');
    const bare = await rig.get('/auth/agents', forgejo);
    expect(bare.status).toBe(404);
    expect(await bare.json()).toMatchObject({
      error: 'host-key-required',
      agents: ['/auth/github/agents', '/auth/forgejo/agents'],
    });
  });

  it('tells the wiki which agent addresses fit its host', async () => {
    const rig = await twoHostRig({ agents: true });
    const both = await rig.signIn('forgejo', 'alice', await rig.signIn('github', 'alice'));
    const onForgejo = (await (await rig.get('/w/forgejo/team/f/auth/me', both)).json()) as {
      headers: Record<string, string>;
    };
    expect(onForgejo.headers['x-gitquire-agents-host']).toBe('forgejo');
    expect(onForgejo.headers['x-gitquire-agents']).toContain('tokens');
    const onGitHub = (await (await rig.get('/w/github/team/g/auth/me', both)).json()) as {
      headers: Record<string, string>;
    };
    expect(onGitHub.headers['x-gitquire-agents-host']).toBe('github');
    expect(onGitHub.headers['x-gitquire-agents']).toContain('tokens');
  });

  it('links each account to its own agents page when signing out', async () => {
    const rig = await twoHostRig({ agents: true });
    const both = await rig.signIn('forgejo', 'alice', await rig.signIn('github', 'alice'));
    const html = await (await rig.get('/auth/logout', both, { accept: 'text/html' })).text();
    expect(html).toContain('href="/auth/github/agents"');
    expect(html).toContain('href="/auth/forgejo/agents"');
  });

  it('publishes connector metadata per host', async () => {
    const rig = await twoHostRig({ agents: true, connectors: true });
    const first = (await (
      await rig.get('/.well-known/oauth-protected-resource/mcp/github', '')
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(first.resource).toBe(`${rig.base}/mcp/github`);
    expect(first.authorization_servers).toEqual([`${rig.base}/oauth/github`]);
    expect((await rig.get('/.well-known/oauth-protected-resource/mcp', '')).status).toBe(404);
    const further = (await (
      await rig.get('/.well-known/oauth-protected-resource/mcp/forgejo', '')
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(further.resource).toBe(`${rig.base}/mcp/forgejo`);
    expect(further.authorization_servers).toEqual([`${rig.base}/oauth/forgejo`]);
    const server = (await (
      await rig.get('/.well-known/oauth-authorization-server/oauth/forgejo', '')
    ).json()) as { issuer: string; authorization_endpoint: string; token_endpoint: string };
    expect(server.issuer).toBe(`${rig.base}/oauth/forgejo`);
    expect(server.authorization_endpoint).toBe(`${rig.base}/oauth/forgejo/authorize`);
    expect(server.token_endpoint).toBe(`${rig.base}/oauth/forgejo/token`);
    const refused = await rig.get('/mcp/forgejo', '');
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain(
      `${rig.base}/.well-known/oauth-protected-resource/mcp/forgejo`,
    );
  });

  it('does not accept a client registered with one host at the other', async () => {
    const rig = await twoHostRig({ agents: true, connectors: true });
    const registered = await httpFetch(`${rig.base}/oauth/forgejo/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    const github = await rig.signIn('github', 'alice');
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      response_type: 'code',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      state: 's',
    });
    const there = await rig.get(`/oauth/github/authorize?${query}`, github, {
      accept: 'text/html',
    });
    expect(there.status).toBe(400);
  });
});
