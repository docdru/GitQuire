import { readProcessStart as readServerProcessStart } from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import { describeHolderStartReadFailure, readHolderProcessStart } from './holder-process-start.ts';

describe('readHolderProcessStart', () => {
  test.skipIf(process.platform === 'win32')(
    'reads a holder on this host the way the server records it in a lock',
    () => {
      expect(readHolderProcessStart(process.pid)).toEqual(readServerProcessStart(process.pid));
    },
  );

  test('cannot read a Windows holder', () => {
    expect(readHolderProcessStart(4242, { platform: 'win32' })).toBeNull();
  });
});

describe('describeHolderStartReadFailure', () => {
  test('names the /proc read on Linux', () => {
    expect(
      describeHolderStartReadFailure({
        platform: 'linux',
        pid: 42,
        nativeFailures: [],
        causeRecorded: false,
      }),
    ).toContain('/proc/42/stat');
  });
});
