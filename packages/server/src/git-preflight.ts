import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { accessSync, existsSync, constants as fsConstants, statSync } from 'node:fs';
import { isAbsolute, join, delimiter as PATH_DELIM } from 'node:path';
import { currentCliCommandName } from '@gitquire/core';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';

export const MIN_GIT_VERSION = '2.31.0';

const PROBE_TIMEOUT_MS = 5000;

export interface GitDetected {
  readonly ok: true;
  readonly version: string;
  readonly resolvedPath: string;
  readonly source: 'PATH' | 'fallback';
}

export interface InstallOption {
  readonly label: string;
  readonly command: string;
  readonly requiresAdmin: boolean;
}

export interface InstallGuidance {
  readonly product: string;
  readonly options: readonly InstallOption[];
  readonly url: string;
}

type GitProbeFailureReason = 'enoent' | 'spawn-failed' | 'unparseable' | 'timeout' | 'nonzero';

export interface GitProbeFailures {
  readonly path: GitProbeFailureReason;
  readonly fallback: GitProbeFailureReason | null;
}

export class GitNotAvailableError extends Error {
  readonly code = 'GIT_NOT_AVAILABLE';
  readonly platform: NodeJS.Platform;
  readonly guidance: InstallGuidance;
  readonly probe: GitProbeFailures | null;

  constructor(
    platform: NodeJS.Platform,
    guidance: InstallGuidance,
    options?: { cause?: unknown; probe?: GitProbeFailures },
  ) {
    super(buildMissingMessage(guidance), options);
    this.name = 'GitNotAvailableError';
    this.platform = platform;
    this.guidance = guidance;
    this.probe = options?.probe ?? null;
  }
}

export class GitProbeTimeoutError extends Error {
  readonly code = 'GIT_PROBE_TIMEOUT';
  readonly platform: NodeJS.Platform;
  readonly guidance: InstallGuidance;
  readonly probe: GitProbeFailures;

  constructor(platform: NodeJS.Platform, guidance: InstallGuidance, probe: GitProbeFailures) {
    super(buildProbeTimeoutMessage(guidance, probe));
    this.name = 'GitProbeTimeoutError';
    this.platform = platform;
    this.guidance = guidance;
    this.probe = probe;
  }
}

export class GitTooOldError extends Error {
  readonly code = 'GIT_TOO_OLD';
  readonly platform: NodeJS.Platform;
  readonly detected: string;
  readonly required: string;
  readonly resolvedPath: string;
  readonly guidance: InstallGuidance;

  constructor(
    platform: NodeJS.Platform,
    detected: string,
    required: string,
    resolvedPath: string,
    guidance: InstallGuidance,
    options?: { cause?: unknown },
  ) {
    super(buildTooOldMessage(detected, required, resolvedPath, guidance), options);
    this.name = 'GitTooOldError';
    this.platform = platform;
    this.detected = detected;
    this.required = required;
    this.resolvedPath = resolvedPath;
    this.guidance = guidance;
  }
}

export function detectGit(): GitDetected {
  const stage1 = probeGit('git');
  if (stage1.kind === 'ok') {
    return {
      ok: true,
      version: stage1.version,
      resolvedPath: stage1.resolvedPath,
      source: 'PATH',
    };
  }

  let fallback: GitProbeFailureReason | null = null;
  let fallbackTimedOut = false;
  for (const candidate of fallbackPaths()) {
    if (!existsSync(candidate)) continue;
    const result = probeGit(candidate);
    if (result.kind === 'ok') {
      return {
        ok: true,
        version: result.version,
        resolvedPath: candidate,
        source: 'fallback',
      };
    }
    fallback = result.reason;
    fallbackTimedOut ||= result.reason === 'timeout';
  }

  const probe = {
    path: stage1.reason,
    fallback: fallbackTimedOut ? 'timeout' : fallback,
  };
  if (stage1.reason === 'timeout' || fallbackTimedOut) {
    throw new GitProbeTimeoutError(process.platform, buildGuidance(), probe);
  }
  throw new GitNotAvailableError(process.platform, buildGuidance(), { probe });
}

export function assertGitAvailable(): GitDetected {
  const detected = detectGit();
  if (compareSemver(detected.version, MIN_GIT_VERSION) < 0) {
    throw new GitTooOldError(
      process.platform,
      detected.version,
      MIN_GIT_VERSION,
      detected.resolvedPath,
      buildGuidance(),
    );
  }
  return detected;
}

type ProbeResult =
  | { kind: 'ok'; version: string; resolvedPath: string }
  | { kind: 'fail'; reason: GitProbeFailureReason };

function probeGit(command: string): ProbeResult {
  const opts: SpawnSyncOptions = withHiddenWindowsConsole({
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  // oxlint-disable-next-line gq/require-windowshide-on-spawn -- windowsHide is set on `opts` via withHiddenWindowsConsole above; the rule can't see through the by-reference options variable.
  const result = spawnSync(command, ['--version'], opts);
  if (result.error) {
    if ('signal' in result && result.signal === 'SIGTERM')
      return { kind: 'fail', reason: 'timeout' };
    const code = (result.error as NodeJS.ErrnoException).code;
    return { kind: 'fail', reason: code === 'ENOENT' ? 'enoent' : 'spawn-failed' };
  }
  if (result.status !== 0) {
    return { kind: 'fail', reason: 'nonzero' };
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const version = parseGitVersion(stdout);
  if (version === null) return { kind: 'fail', reason: 'unparseable' };
  const resolvedPath = command === 'git' ? (resolveOnPath('git') ?? command) : command;
  return { kind: 'ok', version, resolvedPath };
}

export function parseGitVersion(stdout: string): string | null {
  const match = stdout.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

const SAFE_COMMAND_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

const resolveOnPathCache = new Map<string, string>();

export function __resetResolveOnPathCacheForTests(): void {
  resolveOnPathCache.clear();
}

export function __seedResolveOnPathCacheForTests(name: string, resolvedPath: string): void {
  resolveOnPathCache.set(name, resolvedPath);
}

function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveOnPath(name: string, pathOverride?: string): string | null {
  if (!SAFE_COMMAND_NAME_RE.test(name)) return null;
  const cacheKey = pathOverride === undefined ? name : `${pathOverride}\u0000${name}`;
  const cached = resolveOnPathCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const dirs = (pathOverride ?? process.env.PATH ?? '')
    .split(PATH_DELIM)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '' && isAbsolute(dir));
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isRunnableFile(candidate)) {
      resolveOnPathCache.set(cacheKey, candidate);
      return candidate;
    }
  }
  return null;
}

export function fallbackPaths(): readonly string[] {
  return ['/usr/bin/git', '/usr/local/bin/git'];
}

export function buildGuidance(): InstallGuidance {
  return {
    product: 'Git',
    url: 'https://github.com/docdru/GitQuire/blob/main/DEPLOY.md',
    options: [
      {
        label: 'The GitQuire image includes Git; pull or rebuild the image',
        command: 'docker compose pull && docker compose up -d',
        requiresAdmin: false,
      },
    ],
  };
}

function buildMissingMessage(g: InstallGuidance): string {
  const lines: string[] = [];
  lines.push(
    `GitQuire needs ${g.product} to track changes to your knowledge base, but it isn't installed (or isn't on PATH).`,
  );
  lines.push('');
  if (g.options.length > 0) {
    lines.push(`Install ${g.product}:`);
    for (const opt of g.options) {
      const adminTag = opt.requiresAdmin ? ' (admin required)' : '';
      lines.push(`  • ${opt.label}${adminTag}`);
      lines.push(`      ${opt.command}`);
    }
    lines.push('');
  }
  lines.push(`Or download from: ${g.url}`);
  lines.push('');
  lines.push('After installing, re-run GitQuire.');
  lines.push(
    `Run \`${currentCliCommandName()} diagnose health --check git\` to verify your installation.`,
  );
  return lines.join('\n');
}

function buildProbeTimeoutMessage(g: InstallGuidance, probe: GitProbeFailures): string {
  return [
    `GitQuire could not verify ${g.product} because the Git probe timed out. Git may be installed but unavailable while the machine is busy.`,
    '',
    `Probe results: PATH=${probe.path}, fallback=${probe.fallback ?? 'not attempted'}.`,
    'Check that Git is installed and retry GitQuire.',
    `Run \`${currentCliCommandName()} diagnose health --check git\` to verify your installation.`,
  ].join('\n');
}

function buildTooOldMessage(
  detected: string,
  required: string,
  resolvedPath: string,
  g: InstallGuidance,
): string {
  const lines: string[] = [];
  lines.push(
    `GitQuire requires ${g.product} ${required} or newer (detected ${detected} at ${resolvedPath}).`,
  );
  lines.push('');
  if (g.options.length > 0) {
    lines.push(`Update ${g.product}:`);
    for (const opt of g.options) {
      const adminTag = opt.requiresAdmin ? ' (admin required)' : '';
      lines.push(`  • ${opt.label}${adminTag}`);
      lines.push(`      ${opt.command}`);
    }
    lines.push('');
  }
  lines.push(`Or download from: ${g.url}`);
  lines.push('');
  lines.push('After updating, re-run GitQuire.');
  lines.push(
    `Run \`${currentCliCommandName()} diagnose health --check git\` to verify your installation.`,
  );
  return lines.join('\n');
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export const PATH_DELIMITER: string = PATH_DELIM;
