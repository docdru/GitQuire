import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.GITHUB_FAKE_PORT ?? '3443');
const root = process.env.GITHUB_FAKE_ROOT ?? '/tmp/github-fake';
const clientId = process.env.GITHUB_FAKE_CLIENT_ID ?? 'fake-client';
const clientSecret = process.env.GITHUB_FAKE_CLIENT_SECRET ?? 'fake-secret';
const base = `https://127.0.0.1:${port}`;
const repoRoot = join(root, 'repos');

const people = JSON.parse(process.env.GITHUB_FAKE_PEOPLE ?? '{}');
const repos = JSON.parse(
  process.env.GITHUB_FAKE_REPOS ??
    JSON.stringify([
      { id: 501, owner: 'team', name: 'alpha', readme: '# alpha on GitHub\n' },
      { id: 502, owner: 'team', name: 'gamma', readme: '# gamma on GitHub\n' },
    ]),
);
const OWNER_ID = 900;
const INSTALLATION_ID = 77;
const levels = JSON.parse(process.env.GITHUB_FAKE_LEVELS ?? '{}');
const installationTokens = new Map();
const codes = new Map();
const state = { down: false, nextLogin: undefined, delayMs: 0 };
const unknown = [];

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fake',
      GIT_AUTHOR_EMAIL: 'fake@example.org',
      GIT_COMMITTER_NAME: 'Fake',
      GIT_COMMITTER_EMAIL: 'fake@example.org',
    },
  });
}

function seed() {
  rmSync(root, { recursive: true, force: true });
  for (const repo of repos) {
    const bare = join(repoRoot, repo.owner, `${repo.name}.git`);
    mkdirSync(bare, { recursive: true });
    git(['init', '--bare', '--initial-branch', 'main', bare], root);
    git(['config', 'http.receivepack', 'true'], bare);
    if (repo.seedBare !== undefined) {
      rmSync(bare, { recursive: true, force: true });
      git(['clone', '--bare', repo.seedBare, bare], root);
      git(['config', 'http.receivepack', 'true'], bare);
      continue;
    }
    const work = mkdtempSync(join(tmpdir(), 'github-fake-'));
    git(['init', '--initial-branch', 'main', work], root);
    writeFileSync(join(work, 'README.md'), repo.readme ?? `# ${repo.name}\n`);
    git(['add', 'README.md'], work);
    git(['commit', '-m', 'Initial commit'], work);
    git(['-c', 'push.negotiate=false', 'push', bare, 'main'], work);
    rmSync(work, { recursive: true, force: true });
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function bearer(req) {
  const value = req.headers.authorization ?? '';
  const match = /^(?:Bearer|token) (.+)$/i.exec(value);
  return match?.[1];
}

function personOf(token) {
  if (token === undefined || !token.startsWith('ghu_')) return undefined;
  return people[token.slice(4)];
}

function isJwt(token) {
  return token !== undefined && token.split('.').length === 3;
}

function isInstallation(token) {
  const until = token === undefined ? undefined : installationTokens.get(token);
  return until !== undefined && until > Date.now();
}

function levelOf(login, repo) {
  return levels[login]?.[repo.name] ?? 'none';
}

function permissions(level) {
  return {
    admin: level === 'admin',
    maintain: level === 'admin',
    push: level === 'admin' || level === 'write',
    triage: level !== 'none',
    pull: level !== 'none',
  };
}

function repoBody(repo, level) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: true,
    owner: { login: repo.owner, id: OWNER_ID, type: 'Organization' },
    default_branch: 'main',
    html_url: `${base}/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    ...(level === undefined ? {} : { permissions: permissions(level) }),
  };
}

function findRepo(owner, name) {
  return repos.find(
    (repo) =>
      repo.owner.toLowerCase() === owner.toLowerCase() &&
      repo.name.toLowerCase() === name.toLowerCase(),
  );
}

function repoFromPath(parts) {
  if (parts[0] === 'repositories') return repos.find((repo) => String(repo.id) === parts[1]);
  if (parts[0] === 'repos' && parts.length >= 3) return findRepo(parts[1], parts[2]);
  return undefined;
}

async function control(req, res, path) {
  const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
  if (path === '/_fake/next-login') {
    state.nextLogin = body.login;
    return send(res, 200, { ok: true });
  }
  if (path === '/_fake/delay') {
    state.delayMs = Number(body.ms) || 0;
    return send(res, 200, { delayMs: state.delayMs });
  }
  if (path === '/_fake/down') {
    state.down = body.down === true;
    return send(res, 200, { down: state.down });
  }
  if (path === '/_fake/access') {
    levels[body.login] = { ...levels[body.login], [body.repo]: body.level };
    return send(res, 200, { levels });
  }
  if (path === '/_fake/unknown') return send(res, 200, { unknown });
  if (path === '/_fake/readme') {
    const repo = findRepo(body.owner ?? 'team', body.name ?? '');
    if (repo === undefined) return send(res, 404, { message: 'Not Found' });
    const bare = join(repoRoot, repo.owner, `${repo.name}.git`);
    let log = '';
    try {
      log = git(['log', '--format=%an <%ae>|%s', '-n', '20', 'main'], bare);
    } catch {
      log = '';
    }
    return send(res, 200, { log: log.trim().split('\n') });
  }
  return send(res, 404, { message: 'Not Found' });
}

function oauthAuthorize(res, url) {
  const login = state.nextLogin;
  const redirect = url.searchParams.get('redirect_uri') ?? '';
  if (url.searchParams.get('client_id') !== clientId || login === undefined) {
    return send(res, 400, { error: 'bad-authorize' });
  }
  const code = randomBytes(8).toString('hex');
  codes.set(code, login);
  const back = new URL(redirect);
  back.searchParams.set('code', code);
  back.searchParams.set('state', url.searchParams.get('state') ?? '');
  res.writeHead(302, { Location: back.toString() });
  res.end();
}

async function oauthToken(req, res) {
  const raw = await readBody(req);
  const body = raw.trim().startsWith('{')
    ? JSON.parse(raw)
    : Object.fromEntries(new URLSearchParams(raw));
  const login = codes.get(body.code);
  codes.delete(body.code);
  if (body.client_id !== clientId || body.client_secret !== clientSecret || login === undefined) {
    return send(res, 200, { error: 'bad_verification_code' });
  }
  return send(res, 200, { access_token: `ghu_${login}`, token_type: 'bearer', scope: '' });
}

function mint(res) {
  const token = `ghs_${randomBytes(12).toString('hex')}`;
  const expires = Date.now() + 60 * 60_000;
  installationTokens.set(token, expires);
  return send(res, 201, {
    token,
    expires_at: new Date(expires).toISOString(),
    permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  });
}

async function api(req, res, path, url) {
  const token = bearer(req);
  const parts = path.split('/').filter((part) => part !== '');
  const person = personOf(token);
  if (path === '/user') {
    if (person === undefined) return send(res, 401, { message: 'Bad credentials' });
    return send(res, 200, {
      id: person.id,
      login: person.login,
      name: person.name ?? person.login,
      avatar_url: '',
    });
  }
  if (path === '/user/emails') {
    if (person === undefined) return send(res, 401, { message: 'Bad credentials' });
    if (person.emailsRefused === true) {
      return send(res, 403, { message: 'Resource not accessible by integration' });
    }
    return send(res, 200, [
      {
        email: `${person.id}+${person.login}@users.noreply.github.com`,
        primary: false,
        verified: true,
        visibility: null,
      },
      {
        email: person.email ?? `${person.login}@example.org`,
        primary: true,
        verified: true,
        visibility: 'private',
      },
    ]);
  }
  if (path === '/user/installations') {
    if (person === undefined) return send(res, 401, { message: 'Bad credentials' });
    return send(res, 200, { total_count: 1, installations: [{ id: INSTALLATION_ID }] });
  }
  if (path === `/user/installations/${INSTALLATION_ID}/repositories`) {
    if (person === undefined) return send(res, 401, { message: 'Bad credentials' });
    const visible = repos.filter((repo) => levelOf(person.login, repo) !== 'none');
    return send(res, 200, {
      total_count: visible.length,
      repositories: visible.map((repo) => repoBody(repo, levelOf(person.login, repo))),
    });
  }
  if (path === '/app/installations') {
    if (!isJwt(token)) return send(res, 401, { message: 'A JSON web token could not be decoded' });
    return send(res, 200, [{ id: INSTALLATION_ID }]);
  }
  if (path === `/app/installations/${INSTALLATION_ID}/access_tokens` && req.method === 'POST') {
    if (!isJwt(token)) return send(res, 401, { message: 'A JSON web token could not be decoded' });
    await readBody(req);
    return mint(res);
  }
  const repo = repoFromPath(parts);
  const rest = parts[0] === 'repositories' ? parts.slice(2) : parts.slice(3);
  if (repo !== undefined && rest.length === 0) {
    if (person !== undefined) {
      const level = levelOf(person.login, repo);
      return level === 'none'
        ? send(res, 404, { message: 'Not Found' })
        : send(res, 200, repoBody(repo, level));
    }
    if (isInstallation(token)) return send(res, 200, repoBody(repo, 'read'));
    return send(res, 404, { message: 'Not Found' });
  }
  if (repo !== undefined && rest[0] === 'installation' && rest.length === 1) {
    if (!isJwt(token)) return send(res, 401, { message: 'A JSON web token could not be decoded' });
    return send(res, 200, { id: INSTALLATION_ID });
  }
  if (repo !== undefined && rest[0] === 'collaborators' && rest[2] === 'permission') {
    if (!isInstallation(token)) return send(res, 401, { message: 'Bad credentials' });
    const login = decodeURIComponent(rest[1] ?? '');
    if (people[login] === undefined) return send(res, 404, { message: 'Not Found' });
    const level = levelOf(login, repo);
    const permission = level === 'none' ? 'read' : level;
    return send(res, 200, { permission, role_name: permission, user: { login } });
  }
  if (repo !== undefined && rest[0] === 'pulls' && req.method === 'GET') return send(res, 200, []);
  unknown.push(`${req.method} ${path}${url.search}`);
  console.log(`[github-fake] not handled: ${req.method} ${path}${url.search}`);
  return send(res, 404, { message: 'Not Found' });
}

function gitLogin(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Basic (.+)$/i.exec(header);
  if (match === null) return undefined;
  const [, password] = Buffer.from(match[1], 'base64').toString('utf8').split(':');
  if (isInstallation(password)) return 'gitquire-app[bot]';
  return personOf(password)?.login;
}

function gitBackend(req, res, url) {
  const login = gitLogin(req);
  if (login === undefined) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
    res.end();
    return;
  }
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: repoRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      REMOTE_USER: login,
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0);
  let headDone = false;
  child.stdout.on('data', (chunk) => {
    if (headDone) {
      res.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) return;
    headDone = true;
    const lines = head.subarray(0, end).toString('utf8').split('\r\n');
    let status = 200;
    const headers = {};
    for (const line of lines) {
      const at = line.indexOf(':');
      const name = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
  });
  child.stdout.on('end', () => res.end());
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
}

seed();

const server = createServer(
  {
    key: readFileSync(process.env.GITHUB_FAKE_KEY ?? '/tmp/ca/key.pem'),
    cert: readFileSync(process.env.GITHUB_FAKE_CERT ?? '/tmp/ca/cert.pem'),
  },
  (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname;
    if (path.startsWith('/_fake/')) {
      control(req, res, path).catch((err) => send(res, 500, { error: String(err) }));
      return;
    }
    if (state.delayMs > 0) {
      setTimeout(() => handle(req, res, url, path), state.delayMs);
      return;
    }
    handle(req, res, url, path);
  },
);

function handle(req, res, url, path) {
  if (state.down) {
    send(res, 503, { message: 'Service unavailable' });
    return;
  }
  if (path === '/login/oauth/authorize') return oauthAuthorize(res, url);
  if (path === '/login/oauth/access_token' && req.method === 'POST') {
    oauthToken(req, res).catch((err) => send(res, 500, { error: String(err) }));
    return;
  }
  if (path.startsWith('/api/v3/')) {
    api(req, res, path.slice('/api/v3'.length), url).catch((err) =>
      send(res, 500, { error: String(err) }),
    );
    return;
  }
  if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
    gitBackend(req, res, url);
    return;
  }
  unknown.push(`${req.method} ${path}`);
  send(res, 404, { message: 'Not Found' });
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[github-fake] listening on ${base}`);
});
