import { type ProcessStart, readProcessStart } from '@gitquire/server';

export function readHolderProcessStart(pid: number): ProcessStart | null {
  return readProcessStart(pid);
}

export function describeHolderStartReadFailure(pid: number): string {
  return `Linux reads the process start from /proc/${pid}/stat and /proc/stat; restore read access to /proc and retry. `;
}
