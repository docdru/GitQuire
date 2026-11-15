import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export function getEmptyStateCopy({
  isOnboarding,
  isEmbedded,
}: {
  isOnboarding: boolean;
  isEmbedded: boolean;
}): { title: MessageDescriptor; subtitle: MessageDescriptor } {
  if (!isEmbedded) {
    return isOnboarding
      ? {
          title: msg`What would you like to create?`,
          subtitle: msg`Pick a starter pack, or start with a blank page.`,
        }
      : {
          title: msg`Create something great.`,
          subtitle: msg`Start a blank page, or scaffold one from a template.`,
        };
  }
  if (isOnboarding) {
    return {
      title: msg`What would you like to create?`,
      subtitle: msg`Copy a prompt and paste it into your agent to set up your project.`,
    };
  }
  return {
    title: msg`Create something great.`,
    subtitle: msg`Copy a prompt for your agent, start a blank file, or scaffold from a template.`,
  };
}
