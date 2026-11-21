import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const MOVING_IN = '.gitquire-moving-in';
export const MOVING_BACK = '.gitquire-moving-back';
export const FRONT_DOOR_LOCK = 'front-door.lock';

export function interruptedMove(dataDir: string): string | undefined {
  if (existsSync(join(dataDir, MOVING_IN))) return 'gitquire wikis adopt';
  if (existsSync(join(dataDir, MOVING_BACK))) return 'gitquire wikis unadopt';
  return undefined;
}
