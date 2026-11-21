import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathOf, sendJson } from '../http-util.ts';
import { isInternalRequest } from '../internal-request.ts';
import type { RunGit } from '../repo-bootstrap.ts';
import { STOP_STATE_PATH, type StopState } from './pool.ts';

export interface ProjectStopState extends StopState {
  clean: boolean;
  pushed: boolean;
  children: boolean | null;
}

function gitOr(runGit: RunGit, args: string[], dir: string): string | undefined {
  try {
    return runGit(args, dir);
  } catch {
    return undefined;
  }
}

function isPushed(runGit: RunGit, dir: string): boolean {
  const remotes = gitOr(runGit, ['remote'], dir);
  if (remotes === undefined || remotes.trim() === '') return true;
  if (gitOr(runGit, ['rev-parse', '--verify', '--quiet', 'HEAD'], dir) === undefined) return true;
  const upstream = gitOr(runGit, ['rev-list', '--count', '@{upstream}..HEAD'], dir);
  if (upstream !== undefined) return upstream.trim() === '0';
  const branch = gitOr(runGit, ['symbolic-ref', '--quiet', '--short', 'HEAD'], dir)?.trim();
  if (branch === undefined || branch === '') return false;
  const tracked = gitOr(runGit, ['rev-list', '--count', `origin/${branch}..HEAD`], dir);
  return tracked !== undefined && tracked.trim() === '0';
}

export async function projectStopState(
  dir: string,
  runGit: RunGit,
  children: () => Promise<StopState | undefined>,
): Promise<ProjectStopState> {
  const status = gitOr(runGit, ['status', '--porcelain'], dir);
  const clean = status !== undefined && status.trim() === '';
  const pushed = isPushed(runGit, dir);
  const childState = await children().catch(() => undefined);
  const childrenDone = childState === undefined ? null : childState.pushedAndClean;
  return {
    pushedAndClean: clean && pushed && childrenDone === true,
    clean,
    pushed,
    children: childrenDone,
  };
}

export function createStopStateRoute(
  answer: () => Promise<ProjectStopState>,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    if (pathOf(req).path !== STOP_STATE_PATH) return false;
    if (!isInternalRequest(req)) {
      sendJson(res, 403, { error: 'internal-only' });
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return true;
    }
    answer().then(
      (state) => sendJson(res, 200, state),
      () => sendJson(res, 500, { error: 'stop-state-failed' }),
    );
    return true;
  };
}
