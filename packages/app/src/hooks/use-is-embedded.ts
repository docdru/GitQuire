import { detectEmbeddedHostFromBrowser } from '@gitquire/core/constants/embedded-host';
import { useState } from 'react';

export function useIsEmbedded(): boolean {
  const [embedded] = useState(() => detectEmbeddedHostFromBrowser() != null);
  return embedded;
}
