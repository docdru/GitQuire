import { rmSync } from 'node:fs';
import { afterEach, describe } from 'vitest';
import type { TestClient, TestServer } from './test-harness';

let server: TestServer | undefined;
const clients: TestClient[] = [];
const ownedDirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.cleanup();
  await server?.cleanup();
  server = undefined;
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the server hands its history recorder to the stores that move versions to history', () => {});
