import { currentDesktopProduct, userHomeDisplayPath } from './product.ts';

export const GQ_DIR = '.gitquire';

export const GQ_PROJECT_MARKER = '.gitquire/config.yml';

export const LOCAL_DIR = 'local';

export const WORKTREES_DIRNAME = 'worktrees';

export const SAVED_THEMES_DIRNAME = 'themes';

export const GQ_BIN_DIRNAME = 'bin';

export const GQ_MACHINE_LOCAL_ROOT_FILES = [
  'principal.json',
  'state.json',
  'server.lock',
  'ui.lock',
  'sync-state.json',
  'conflicts.json',
  'last-spawn-error.log',
] as const;

export const GQ_USER_HOME_AUTH_FILE = 'auth.yml';

export const GQ_USER_HOME_SECRETS_FILE = 'secrets.yml';

export const GQ_USER_HOME_CREDENTIAL_FILES = [
  GQ_USER_HOME_AUTH_FILE,
  GQ_USER_HOME_SECRETS_FILE,
] as const;

export const GQ_ACTIVE_MACHINE_LOCAL_ROOT_DIRS = [LOCAL_DIR, WORKTREES_DIRNAME] as const;

export const GQ_MACHINE_LOCAL_ROOT_DIRS = [
  ...GQ_ACTIVE_MACHINE_LOCAL_ROOT_DIRS,
  'cache',
  'tmp',
] as const;

export type GqMachineLocalRootDir = (typeof GQ_MACHINE_LOCAL_ROOT_DIRS)[number];

export type GqMachineLocalRootFile = (typeof GQ_MACHINE_LOCAL_ROOT_FILES)[number];

const activeMachineLocalRootDirs: ReadonlySet<string> = new Set(GQ_ACTIVE_MACHINE_LOCAL_ROOT_DIRS);

export const GQ_LEGACY_MACHINE_LOCAL_ROOT_DIRS: readonly GqMachineLocalRootDir[] =
  GQ_MACHINE_LOCAL_ROOT_DIRS.filter((name) => !activeMachineLocalRootDirs.has(name));

export function posixOkManagedBinDir(
  homeDir: string,
  userHomeDirName: string = currentDesktopProduct().userHomeDirName,
): string {
  const base = homeDir.replace(/\/+/g, '/').replace(/\/+$/, '');
  return `${base}/${userHomeDirName}/${GQ_BIN_DIRNAME}`;
}

export function okUserHomeDisplayPath(...segments: string[]): string {
  return userHomeDisplayPath(currentDesktopProduct(), ...segments);
}
