import { isAbsolute } from 'node:path';

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isWithinDir(child: string, parent: string): boolean {
  const c = toPosix(child);
  const p = toPosix(parent);
  return c === p || c.startsWith(`${p}/`);
}

export function escapesRoot(rel: string): boolean {
  const forwardSlashed = toPosix(rel);
  return forwardSlashed === '..' || forwardSlashed.startsWith('../') || isAbsolute(rel);
}
