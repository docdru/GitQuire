import { adoptLegacyEnv, legacyEnvNotice } from './legacy-env.ts';

for (const name of adoptLegacyEnv(process.env)) process.stderr.write(legacyEnvNotice(name));
