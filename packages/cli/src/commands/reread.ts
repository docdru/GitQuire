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

export async function runReread(opts: RereadOptions, cwd = process.cwd()): Promise<void> {
  const lock = readServerLock(resolveLockDir(cwd));
  if (!lock || lock.port <= 0) {
    throw new Error('No running GitQuire server for this folder. Files are read at start.');
  }
  const res = await (opts.fetchImpl ?? fetch)(
    `http://127.0.0.1:${lock.port}/api/documents/reread`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...clientVersionHeaders({ kind: 'cli', runtimeVersion: RUNTIME_VERSION }),
      },
      body: '{}',
    },
  );
  const body = (await res.json().catch(() => ({}))) as RereadBody;
  if (!res.ok) {
    throw new Error(
      body.title ?? body.error ?? body.message ?? `Server responded with ${res.status}`,
    );
  }
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
