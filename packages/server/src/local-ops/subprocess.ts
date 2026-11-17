import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import { envWithoutDevChannel, type GqCliCommand, type GqCliRefusal } from '@gitquire/core';
import { withHiddenWindowsConsole } from '../child-process-windows-hide.ts';
import type { LocalOpSubprocessLifetime } from './subprocess-lifetime.ts';

interface ParsedLine {
  raw: string;
  parsed: Record<string, unknown> | null;
}

type LocalOpCliEnv = Readonly<Record<string, string | undefined>>;

export const LOCAL_OP_AUTH_SUBPROCESS_TIMEOUT_MS = 30_000;

export interface LocalOpCliInvocation {
  readonly cli: GqCliCommand;
  readonly cwd?: string;
}

interface SubprocessRunOptions {
  readonly cliArgs: readonly string[];
  readonly cliEnv?: LocalOpCliEnv;
  readonly cwd?: string;
  lifetime?: LocalOpSubprocessLifetime;
  trailingArgs: readonly string[];
  extraPathDirs?: readonly string[];
  timeoutMs: number;
  onLine: (line: ParsedLine) => void;
  onStderr?: (chunk: Buffer) => void;
  stdinData?: string;
}

interface SubprocessRunResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

interface SubprocessController {
  done: Promise<SubprocessRunResult>;
  cancel(): void;
}

type GqCliRunResult = SubprocessRunResult | GqCliRefusal;

interface GqCliSubprocessController {
  done: Promise<GqCliRunResult>;
  cancel(): void;
}

function overlayEnvEntry(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

export function buildOverlaidEnv(
  baseEnv: NodeJS.ProcessEnv,
  overlay: LocalOpCliEnv | undefined,
  extraPathDirs: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    overlayEnvEntry(env, key, value);
  }
  if (extraPathDirs && extraPathDirs.length > 0) {
    overlayEnvEntry(
      env,
      'PATH',
      [...extraPathDirs, env.PATH ?? ''].filter(Boolean).join(delimiter),
    );
  }
  return env;
}

const SPAWN_ERROR_FACT_KEYS = ['code', 'errno', 'syscall'] as const;

function describeSpawnError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err === null || typeof err !== 'object') return message;
  const facts: string[] = [];
  for (const key of SPAWN_ERROR_FACT_KEYS) {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === 'number' || (typeof value === 'string' && value !== '')) {
      facts.push(`${key}=${value}`);
    }
  }
  return facts.length === 0 ? message : `${message} (${facts.join(' ')})`;
}

export function runSubprocess(opts: SubprocessRunOptions): SubprocessController {
  const [cmd, ...baseArgs] = opts.cliArgs;
  if (!cmd) {
    return {
      done: Promise.resolve({
        code: -1,
        stderr: 'no command provided',
        timedOut: false,
        cancelled: false,
      }),
      cancel: () => {},
    };
  }
  const argv = [...baseArgs, ...opts.trailingArgs];

  let timedOut = false;
  let cancelled = false;
  let stdoutBuffer = '';
  const stderrChunks: Buffer[] = [];

  const childEnv = buildOverlaidEnv(
    envWithoutDevChannel(process.env),
    opts.cliEnv,
    opts.extraPathDirs,
  );

  const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] =
    opts.stdinData !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
  let child: ReturnType<typeof spawn>;
  try {
    const launch = () =>
      spawn(
        cmd,
        argv,
        withHiddenWindowsConsole({
          stdio,
          cwd: opts.cwd,
          env: childEnv,
        }),
      );
    child = opts.lifetime ? opts.lifetime.spawn(launch) : launch();
  } catch (err) {
    return {
      done: Promise.resolve({
        code: -1,
        stderr: describeSpawnError(err),
        timedOut: false,
        cancelled: false,
      }),
      cancel: () => {},
    };
  }

  if (opts.stdinData !== undefined && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.write(opts.stdinData);
    child.stdin.end();
  }

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, opts.timeoutMs);

  const flushLine = (raw: string): void => {
    if (!raw.trim()) return;
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(raw);
      parsed = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    opts.onLine({ raw, parsed });
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) flushLine(line);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    opts.onStderr?.(chunk);
  });

  const done = new Promise<SubprocessRunResult>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (stdoutBuffer.trim()) flushLine(stdoutBuffer);
      stdoutBuffer = '';
      resolve({
        code,
        stderr: Buffer.concat(stderrChunks).toString('utf-8').trim(),
        timedOut,
        cancelled,
      });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      stderrChunks.push(Buffer.from(describeSpawnError(err), 'utf-8'));
      resolve({
        code: -1,
        stderr: Buffer.concat(stderrChunks).toString('utf-8').trim(),
        timedOut,
        cancelled,
      });
    });
  });

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      if (!child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
    },
  };
}

export function runOkCliSubprocess(
  cli: GqCliCommand,
  opts: Omit<SubprocessRunOptions, 'cliArgs' | 'cliEnv'>,
): GqCliSubprocessController {
  const invocation = cli.runnerInvocation(opts.trailingArgs);
  if ('refused' in invocation) {
    return { done: Promise.resolve({ refused: invocation.refused }), cancel: () => {} };
  }
  return runSubprocess({ ...opts, ...invocation, trailingArgs: [] });
}
