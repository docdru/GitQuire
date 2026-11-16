#!/usr/bin/env node

import {
  gitCredentialHelperOperation,
  handleCredentialUpdate,
} from './commands/auth/git-credential-operation.ts';

const helperOperation = gitCredentialHelperOperation(process.argv.slice(2));
if (helperOperation === 'get') {
  const { runGitCredentialGet } = await import('./commands/auth/git-credential-helper.ts');
  process.exit(await runGitCredentialGet());
}
if (helperOperation !== null) {
  process.exit(await handleCredentialUpdate(helperOperation, process.stdin));
}

await import('zod/compile');
await import('./cli.ts');
