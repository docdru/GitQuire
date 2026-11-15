import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executable(name: string): string {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((ext) => ext.trim())
          .filter((ext) => ext !== '')
      : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return realpathSync(candidate);
    }
  }
  throw new Error(`Missing test prerequisite: ${name}`);
}

export function npmCli(name: 'npm' | 'npx'): string {
  const command = executable('npx');
  const path =
    process.platform === 'win32'
      ? join(dirname(command), 'node_modules', 'npm', 'bin', `${name}-cli.js`)
      : join(dirname(command), `${name}-cli.js`);
  if (!existsSync(path)) throw new Error(`Missing test prerequisite: ${path}`);
  return path;
}

export function isolateNpmHome(
  home: string,
  { registry, cache }: { registry: string; cache: string },
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const inherited = (key: string) =>
    Object.entries(source).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  const env: Record<string, string | undefined> = {
    PATH: inherited('PATH'),
    PATHEXT: inherited('PATHEXT'),
    SystemRoot: inherited('SystemRoot'),
    ComSpec: inherited('ComSpec'),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    npm_config_cache: cache,
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_globalconfig: join(home, 'global.npmrc'),
    npm_config_registry: registry,
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    DO_NOT_TRACK: '1',
  };
  writeFileSync(join(home, '.npmrc'), '');
  writeFileSync(join(home, 'global.npmrc'), '');
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function awaitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {}
  try {
    child.kill(signal);
  } catch {}
}

async function terminateTree(child: ChildProcess, graceMs: number): Promise<boolean> {
  const forceWaitMs = 2_000;
  if (hasExited(child)) return true;
  if (process.platform === 'win32') {
    if (child.pid !== undefined) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        }).unref();
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }
    return awaitExit(child, Math.max(graceMs, forceWaitMs));
  }
  signalTree(child, 'SIGTERM');
  if (await awaitExit(child, graceMs)) return true;
  signalTree(child, 'SIGKILL');
  return awaitExit(child, forceWaitMs);
}

export async function captureChild(
  child: ChildProcess,
  { timeoutMs = 60_000, graceMs = 100 }: { timeoutMs?: number; graceMs?: number } = {},
) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => void terminateTree(child, graceMs), timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    await terminateTree(child, graceMs);
  }
}
