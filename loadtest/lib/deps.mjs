import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const fromApp = createRequire(
  fileURLToPath(new URL('../../packages/app/package.json', import.meta.url)),
);

export const Y = fromApp('yjs');
export const { HocuspocusProvider, HocuspocusProviderWebsocket } = fromApp('@hocuspocus/provider');
export const WebSocket = fromApp('ws');
