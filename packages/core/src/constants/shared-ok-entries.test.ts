import { describe, expect, test } from 'vitest';
import { LOCAL_DIR } from './ok-dir.ts';
import {
  MACHINE_ID_FILENAME,
  SERVER_AUTHORITY_LEASES_DIRNAME,
  SERVER_AUTHORITY_REGISTRY_FILENAME,
  SHARED_OK_ENTRIES,
} from './shared-ok-entries.ts';

describe('SHARED_OK_ENTRIES', () => {
  test('each entry is the path its writer uses under the OK dir', () => {
    expect([...SHARED_OK_ENTRIES]).toEqual([
      'machine-id',
      'local/server-authority.sqlite',
      'local/server-authority.sqlite-journal',
      'local/server-authority-leases',
    ]);
    expect(SHARED_OK_ENTRIES).toEqual([
      MACHINE_ID_FILENAME,
      `${LOCAL_DIR}/${SERVER_AUTHORITY_REGISTRY_FILENAME}`,
      `${LOCAL_DIR}/${SERVER_AUTHORITY_REGISTRY_FILENAME}-journal`,
      `${LOCAL_DIR}/${SERVER_AUTHORITY_LEASES_DIRNAME}`,
    ]);
  });
});
