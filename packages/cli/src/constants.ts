import pkgJson from '../package.json' with { type: 'json' };

export { GQ_DIR } from '@gitquire/core';

export const CONFIG_FILENAME = 'config.yml';

export const PACKAGE_VERSION = pkgJson.version;
