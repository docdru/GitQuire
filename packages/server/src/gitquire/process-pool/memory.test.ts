import { describe, expect, it } from 'vitest';
import {
  containerMemory,
  MIN_IDLE_BEFORE_MAKING_ROOM_MS,
  makeRoom,
  memoryTight,
  ServerBusyError,
} from './memory.ts';

function files(map: Record<string, string>): (path: string) => string {
  return (path) => {
    const name = path.split('/').pop() ?? '';
    const value = map[name];
    if (value === undefined) throw new Error(`no ${path}`);
    return value;
  };
}

describe('container memory', () => {
  it('reads the cgroup use without the page cache, and its limit', () => {
    const use = containerMemory(
      files({
        'memory.current': '3000\n',
        'memory.max': '4000\n',
        'memory.stat': 'anon 2000\ninactive_file 500\nactive_file 300\n',
      }),
      () => 16_000,
    );
    expect(use).toEqual({ usedBytes: 2500, limitBytes: 4000 });
  });

  it('takes the machine size when the cgroup has no limit, and nothing outside a cgroup', () => {
    expect(
      containerMemory(files({ 'memory.current': '100', 'memory.max': 'max' }), () => 1000),
    ).toEqual({ usedBytes: 100, limitBytes: 1000 });
    expect(containerMemory(files({}), () => 1000)).toBeUndefined();
  });

  it('is tight above 80 %', () => {
    expect(memoryTight({ usedBytes: 800, limitBytes: 1000 })).toBe(false);
    expect(memoryTight({ usedBytes: 801, limitBytes: 1000 })).toBe(true);
    expect(memoryTight(undefined)).toBe(false);
  });
});

describe('making room', () => {
  const idle = 0;
  const now = () => MIN_IDLE_BEFORE_MAKING_ROOM_MS + 10;

  it('sleeps the longest-idle processes, oldest first, until memory is under 80 %', async () => {
    let used = 950;
    const slept: string[] = [];
    await makeRoom({
      memory: () => ({ usedBytes: used, limitBytes: 1000 }),
      candidates: () => [
        { id: 'b', idleSinceMs: idle + 5 },
        { id: 'a', idleSinceMs: idle },
        { id: 'c', idleSinceMs: idle + 9 },
      ],
      sleep: async (id) => {
        slept.push(id);
        used -= 100;
        return true;
      },
      now,
    });
    expect(slept).toEqual(['a', 'b']);
  });

  it('is busy when only recently used or unstoppable processes are left', async () => {
    const slept: string[] = [];
    await expect(
      makeRoom({
        memory: () => ({ usedBytes: 950, limitBytes: 1000 }),
        candidates: () => [
          { id: 'dirty', idleSinceMs: idle },
          { id: 'fresh', idleSinceMs: now() - 1000 },
        ],
        sleep: async (id) => {
          slept.push(id);
          return false;
        },
        now,
      }),
    ).rejects.toBeInstanceOf(ServerBusyError);
    expect(slept).toEqual(['dirty']);
  });
});
