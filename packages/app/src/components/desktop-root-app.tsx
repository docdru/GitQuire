import type { ReactElement } from 'react';
import { App } from '@/App';
import { NavigatorApp } from '@/components/NavigatorApp';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

export function selectDesktopRootApp(bridge: OkDesktopBridge | undefined): ReactElement {
  if (bridge?.config.mode === 'navigator') return <NavigatorApp bridge={bridge} />;
  return <App />;
}
