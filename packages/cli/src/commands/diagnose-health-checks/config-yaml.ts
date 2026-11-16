import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentCliCommandName } from '@gitquire/core';
import { loadConfig } from '../../config/loader.ts';
import { CONFIG_FILENAME, GQ_DIR } from '../../constants.ts';
import type { CheckContext, CheckDefinition, CheckResult } from './types.ts';

interface ConfigYamlCheckDeps {
  loader?: (cwd: string) => { sources: string[]; config: { content: { dir: string } } };
}

export function makeConfigYamlCheck(deps: ConfigYamlCheckDeps = {}): CheckDefinition {
  const load = deps.loader ?? loadConfig;
  return {
    name: 'config-yaml',
    run: async (ctx: CheckContext): Promise<CheckResult> => {
      const configPath = resolve(ctx.cwd, GQ_DIR, CONFIG_FILENAME);
      if (!existsSync(configPath)) {
        return {
          name: 'config-yaml',
          status: 'warn',
          summary: `${GQ_DIR}/${CONFIG_FILENAME} not found (project not initialized)`,
          remediation: `Run \`${currentCliCommandName()} init\` to scaffold the project.`,
        };
      }
      try {
        const { config, sources } = load(ctx.cwd);
        return {
          name: 'config-yaml',
          status: 'pass',
          summary: `parses; content.dir = ${config.content.dir}`,
          detail: `sources: ${sources.join(', ')}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          name: 'config-yaml',
          status: 'fail',
          summary: `${GQ_DIR}/${CONFIG_FILENAME} failed to parse`,
          detail: message,
        };
      }
    },
  };
}
