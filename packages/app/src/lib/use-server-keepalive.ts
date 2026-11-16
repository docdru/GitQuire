import { startKeepalive as defaultStartKeepalive } from '@gitquire/core/keepalive';
import { useEffect, useRef } from 'react';

export function keepaliveBaseFromCollabUrl(collabUrl: string | null): string | undefined {
  if (!collabUrl) return undefined;
  return collabUrl.replace(/\/collab\/?$/, '');
}

export interface UseServerKeepaliveOptions {
  startKeepalive?: typeof defaultStartKeepalive;
}

export function useServerKeepalive(
  collabUrl: string | null,
  options?: UseServerKeepaliveOptions,
): void {
  const collabUrlRef = useRef(collabUrl);
  const optionsRef = useRef(options);

  useEffect(() => {
    collabUrlRef.current = collabUrl;
  }, [collabUrl]);

  useEffect(() => {
    const start = optionsRef.current?.startKeepalive ?? defaultStartKeepalive;
    const handle = start({
      resolveWsUrl: async () => keepaliveBaseFromCollabUrl(collabUrlRef.current),
    });
    return () => handle.close();
  }, []);
}
