import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export function getEmptyStateCopy({
  isOnboarding,
  isEmbedded,
  askAi = true,
}: {
  isOnboarding: boolean;
  isEmbedded: boolean;
  askAi?: boolean;
}): { title: MessageDescriptor; subtitle: MessageDescriptor } {
  if (!askAi && !isEmbedded) {
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
      subtitle: isEmbedded
        ? msg`Copy a prompt and paste it into your agent to set up your project.`
        : msg`Describe what you're working on and the agent sets it up for you.`,
    };
  }
  return {
    title: msg`Create something great.`,
    subtitle: isEmbedded
      ? msg`Copy a prompt for your agent, start a blank file, or scaffold from a template.`
      : msg`Describe what you want to build, start a blank file, or scaffold from a template.`,
  };
}
