'use client';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function Provider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{
        options: {
          type: 'static',
          api: `${basePath}/api/search`,
        },
      }}
    >
      {children}
    </RootProvider>
  );
}
