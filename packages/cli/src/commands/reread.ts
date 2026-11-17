import { clientVersionHeaders } from '@gitquire/core';
import { RUNTIME_VERSION, readServerLock, resolveLockDir } from '@gitquire/server';
import { Command } from 'commander';

export interface RereadOptions {
  json: boolean;
  fetchImpl?: typeof fetch;
}

interface RereadBody {
  status?: string;
  found?: number;
  title?: string;
  error?: string;
  message?: string;
}

function runningServerPort(cwd: string): number | null {
  const lock = readServerLock(resolveLockDir(cwd));
  return lock && lock.port > 0 ? lock.port : null;
}

async function requestReread(port: number, fetchImpl: typeof fetch): Promise<RereadBody> {
  const res = await fetchImpl(`http://127.0.0.1:${port}/api/documents/reread`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...clientVersionHeaders({ kind: 'cli', runtimeVersion: RUNTIME_VERSION }),
    },
    body: '{}',
  });
  const body = (await res.json().catch(() => ({}))) as RereadBody;
  if (!res.ok) {
    throw new Error(
      body.title ?? body.error ?? body.message ?? `Server responded with ${res.status}`,
    );
  }
  return body;
}

export async function rereadIfRunning(
  cwd: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const port = runningServerPort(cwd);
  if (port === null) return false;
  await requestReread(port, fetchImpl);
  return true;
}

export async function runReread(opts: RereadOptions, cwd = process.cwd()): Promise<void> {
  const port = runningServerPort(cwd);
  if (port === null) {
    throw new Error('No running GitQuire server for this folder. Files are read at start.');
  }
  const body = await requestReread(port, opts.fetchImpl ?? fetch);
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ type: 'complete', status: body.status, found: body.found ?? 0 })}\n`,
    );
    return;
  }
  const found = body.found ?? 0;
  process.stderr.write(
    body.status === 'completed'
      ? `✓ Re-read the content folder: ${found} ${found === 1 ? 'change' : 'changes'} taken in\n`
      : `Re-read finished as ${body.status ?? 'unknown'}: ${found} taken in\n`,
  );
}

export function rereadCommand(): Command {
  return new Command('reread')
    .description('Make the running server read the content folder from disk again')
    .option('--json', 'Output the result as JSON', false)
    .action(async (opts: { json: boolean }) => {
      try {
        await runReread({ json: opts.json });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) process.stdout.write(`${JSON.stringify({ type: 'error', message: msg })}\n`);
        else process.stderr.write(`✗ reread failed: ${msg}\n`);
        process.exit(1);
      }
    });
}
