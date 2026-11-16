import {
  type DesktopProduct,
  desktopProductForCliCommand,
  userHomeDisplayPath,
} from '@gitquire/core/constants/product';

function rendererDesktopProduct(): DesktopProduct {
  return desktopProductForCliCommand(null);
}

export function okCliCommandName(): string {
  return rendererDesktopProduct().cliCommandNames[0];
}

export function okUserHomeLabel(...segments: string[]): string {
  return userHomeDisplayPath(rendererDesktopProduct(), ...segments);
}
