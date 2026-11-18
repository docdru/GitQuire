import { readProcessStart as readServerProcessStart } from '@gitquire/server';
import { describe, expect, test } from 'vitest';
import { describeHolderStartReadFailure, readHolderProcessStart } from './holder-process-start.ts';

describe('readHolderProcessStart', () => {
  test('reads a holder on this host the way the server records it in a lock', () => {
    expect(readHolderProcessStart(process.pid)).toEqual(readServerProcessStart(process.pid));
  });
});

describe('describeHolderStartReadFailure', () => {
  test('names the /proc read', () => {
    expect(describeHolderStartReadFailure(42)).toContain('/proc/42/stat');
  });
});
