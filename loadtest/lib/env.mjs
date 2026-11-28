import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export const settings = {
  target: process.env.LOADTEST_TARGET ?? 'docker',
  image: process.env.LOADTEST_IMAGE ?? 'gitquire:ci',
  cpus: process.env.LOADTEST_CPUS ?? '2',
  memory: process.env.LOADTEST_MEMORY ?? '4g',
  port: Number(process.env.LOADTEST_PORT ?? '8300'),
  fakePort: Number(process.env.LOADTEST_FAKE_PORT ?? '3443'),
  ca: process.env.LOADTEST_CA ?? '/tmp/ca',
  work: process.env.LOADTEST_WORK ?? '/tmp/loadtest',
  container: 'gq-loadtest',
  serverEnv: JSON.parse(process.env.LOADTEST_SERVER_ENV?.trim() || '{}'),
};

export const base = () => `http://127.0.0.1:${settings.port}`;
export const fakeBase = () => `https://127.0.0.1:${settings.fakePort}`;
export const fakeRepoRoot = () => join(settings.work, 'fake');

export function login(n) {
  return `u${String(n).padStart(3, '0')}`;
}

export function people(count) {
  const out = {};
  for (let i = 1; i <= count; i++)
    out[login(i)] = { id: 10_000 + i, login: login(i), name: `Person ${i}` };
  return out;
}

let fake;
let local;

export async function startFake({ repos, persons, levels }) {
  await stopFake();
  fake = spawn('node', [join(repoRoot, '.github/prototypes/github-fake.mjs')], {
    env: {
      ...process.env,
      GITHUB_FAKE_PORT: String(settings.fakePort),
      GITHUB_FAKE_ROOT: fakeRepoRoot(),
      GITHUB_FAKE_KEY: join(settings.ca, 'key.pem'),
      GITHUB_FAKE_CERT: join(settings.ca, 'cert.pem'),
      GITHUB_FAKE_PEOPLE: JSON.stringify(persons),
      GITHUB_FAKE_LEVELS: JSON.stringify(levels),
      GITHUB_FAKE_REPOS: JSON.stringify(repos),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fake.stderr.on('data', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake did not start')), 120_000);
    fake.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    fake.on('exit', (code) => reject(new Error(`fake exited ${code}`)));
  });
}

export async function stopFake() {
  if (fake === undefined) return;
  const child = fake;
  fake = undefined;
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

export async function fakeControl(path, body) {
  const res = await fetch(`${fakeBase()}/_fake/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

function serverEnv(extra) {
  return {
    NODE_EXTRA_CA_CERTS: '/ca/cert.pem',
    GIT_SSL_CAINFO: '/ca/cert.pem',
    PORT: String(settings.port),
    GITQUIRE_ALLOW_EXTERNAL: '1',
    GITQUIRE_EXTERNAL_URL: base(),
    GITQUIRE_WIKIS: 'on',
    GITQUIRE_ALLOWED_OWNERS: 'team',
    GITQUIRE_ADMINS: login(1),
    GITHUB_APP_CLIENT_ID: 'fake-client',
    GITHUB_APP_CLIENT_SECRET: 'fake-secret',
    GITHUB_APP_ID: '4242',
    GITHUB_APP_PRIVATE_KEY_FILE: '/ca/app.pem',
    GITQUIRE_GITHUB_WEB_URL: fakeBase(),
    GITQUIRE_GITHUB_API_URL: `${fakeBase()}/api/v3`,
    GITQUIRE_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    ...settings.serverEnv,
    ...extra,
  };
}

export async function startServer(extra = {}) {
  await stopServer();
  const env = serverEnv(extra);
  if (settings.target === 'docker') {
    execFileSync('docker', ['volume', 'rm', '-f', 'gq-loadtest'], { stdio: 'ignore' });
    const args = ['run', '-d', '--name', settings.container, '--network', 'host'];
    args.push(
      '--cpus',
      settings.cpus,
      '--memory',
      settings.memory,
      '--memory-swap',
      settings.memory,
    );
    args.push('-v', 'gq-loadtest:/data', '-v', `${settings.ca}:/ca:ro`);
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(settings.image);
    execFileSync('docker', args, { stdio: 'ignore' });
  } else {
    const data = join(settings.work, 'data');
    rmSync(data, { recursive: true, force: true });
    mkdirSync(data, { recursive: true });
    const localEnv = { ...env, GITQUIRE_BIND: '127.0.0.1' };
    for (const key of ['NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'GITHUB_APP_PRIVATE_KEY_FILE']) {
      localEnv[key] = localEnv[key].replace('/ca/', `${settings.ca}/`);
    }
    local = spawn('gitquire', ['front-door', data], {
      env: { ...process.env, ...localEnv },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
  }
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    try {
      const res = await fetch(`${base()}/readyz`);
      if (res.ok) return Date.now() - started;
    } catch {}
    await wait(250);
  }
  throw new Error(`server not ready: ${serverLogs(80)}`);
}

export function serverLogs(lines = 200) {
  try {
    if (settings.target === 'docker') {
      return execFileSync('docker', ['logs', '--tail', String(lines), settings.container], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch {}
  return '';
}

export async function stopServer() {
  if (settings.target === 'docker') {
    try {
      execFileSync('docker', ['rm', '-f', settings.container], { stdio: 'ignore' });
    } catch {}
    return;
  }
  if (local !== undefined && local.exitCode === null) {
    const child = local;
    local = undefined;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    await wait(500);
  }
}

export function inServer(script) {
  if (settings.target === 'docker') {
    return execFileSync('docker', ['exec', settings.container, 'sh', '-c', script], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
  }
  return execFileSync('sh', ['-c', script], { encoding: 'utf8', maxBuffer: 1 << 26 });
}

export function serverRootPid() {
  if (settings.target === 'docker') return 1;
  return local?.pid;
}

export function hostFile(repo, path) {
  try {
    return execFileSync(
      'git',
      ['--git-dir', join(fakeRepoRoot(), 'repos', 'team', `${repo}.git`), 'show', `main:${path}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 },
    );
  } catch {
    return '';
  }
}
