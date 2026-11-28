import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

export const MEMORY_ROOM_SHARE = 0.8;
export const MIN_IDLE_BEFORE_MAKING_ROOM_MS = 60_000;
const CGROUP = '/sys/fs/cgroup';

export interface MemoryUse {
  usedBytes: number;
  limitBytes: number;
}

export type ReadMemory = () => MemoryUse | undefined;

type ReadText = (path: string) => string;

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function statValue(stat: string, name: string): number {
  for (const line of stat.split('\n')) {
    const [key, value] = line.split(' ');
    if (key === name) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }
  return 0;
}

export function containerMemory(
  read: ReadText = readTextFile,
  machineBytes: () => number = totalmem,
): MemoryUse | undefined {
  let current: number;
  try {
    current = Number(read(`${CGROUP}/memory.current`).trim());
  } catch {
    return undefined;
  }
  if (!Number.isFinite(current) || current <= 0) return undefined;
  let limitBytes = machineBytes();
  try {
    const max = read(`${CGROUP}/memory.max`).trim();
    if (max !== 'max' && Number.isFinite(Number(max)) && Number(max) > 0) {
      limitBytes = Math.min(limitBytes, Number(max));
    }
  } catch {}
  let reclaimable = 0;
  try {
    reclaimable = statValue(read(`${CGROUP}/memory.stat`), 'inactive_file');
  } catch {}
  return { usedBytes: Math.max(0, current - reclaimable), limitBytes };
}

export function memoryTight(use: MemoryUse | undefined, share = MEMORY_ROOM_SHARE): boolean {
  return use !== undefined && use.usedBytes > share * use.limitBytes;
}

export class ServerBusyError extends Error {
  constructor(message = 'This server is busy. Try again in a minute.') {
    super(message);
    this.name = 'ServerBusyError';
  }
}

export interface Sleeper {
  id: string;
  idleSinceMs: number;
}

export async function makeRoom(deps: {
  memory: ReadMemory;
  candidates: () => readonly Sleeper[];
  sleep: (id: string) => Promise<boolean>;
  now: () => number;
  onSlept?: (id: string, use: MemoryUse) => void;
}): Promise<void> {
  const tried = new Set<string>();
  for (;;) {
    const use = deps.memory();
    if (!memoryTight(use)) return;
    const next = deps
      .candidates()
      .filter(
        (c) => !tried.has(c.id) && deps.now() - c.idleSinceMs >= MIN_IDLE_BEFORE_MAKING_ROOM_MS,
      )
      .sort((a, b) => a.idleSinceMs - b.idleSinceMs)[0];
    if (next === undefined) throw new ServerBusyError();
    tried.add(next.id);
    if ((await deps.sleep(next.id)) && use !== undefined) deps.onSlept?.(next.id, use);
  }
}
