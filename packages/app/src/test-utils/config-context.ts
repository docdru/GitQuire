import type { ConfigContextValue } from '@/lib/config-context';

export function configContextFixture(): ConfigContextValue {
  return {
    userBinding: null,
    userSynced: true,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: true,
    userConfig: null,
    projectConfig: null,
    projectSynced: true,
    projectLocalConfig: null,
    projectLocalSynced: true,
    merged: null,
  };
}
