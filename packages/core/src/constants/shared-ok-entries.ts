import { LOCAL_DIR } from './ok-dir.ts';

export const MACHINE_ID_FILENAME = 'machine-id';

export const SERVER_AUTHORITY_REGISTRY_FILENAME = 'server-authority.sqlite';

export const SERVER_AUTHORITY_LEASES_DIRNAME = 'server-authority-leases';

export const SHARED_OK_ENTRIES: readonly string[] = [
  MACHINE_ID_FILENAME,
  `${LOCAL_DIR}/${SERVER_AUTHORITY_REGISTRY_FILENAME}`,
  `${LOCAL_DIR}/${SERVER_AUTHORITY_REGISTRY_FILENAME}-journal`,
  `${LOCAL_DIR}/${SERVER_AUTHORITY_LEASES_DIRNAME}`,
];
