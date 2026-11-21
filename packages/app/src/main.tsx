import { initFrontendTelemetry } from './telemetry';

initFrontendTelemetry();
void import('./telemetry-startup').then((m) => m.initStartupTrace());

import '@/lib/perf/scheduler-polyfill-shim';
import '@/lib/promise-with-resolvers-polyfill';

import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { installClientFetchWrapper } from '@/lib/client-fetch';
import { installContactEmailStore } from '@/lib/contact-email-store';
import { wikiPrefix } from '@/lib/gitquire/wiki-prefix';
import { i18n } from '@/lib/i18n';
import { installClientLogForwarder } from '@/lib/install-client-log-forwarder';
import { initWebVitals } from '@/lib/perf';
import {
  installColdMountInstrumentation,
  shouldInstallColdMountInstrumentation,
} from '@/lib/perf/cold-mount-instrumentation';
import { requestStoragePersistence } from '@/lib/request-storage-persistence';
import { installSubscribeCardStore } from '@/lib/subscribe-card-store';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'react-medium-image-zoom/dist/styles.css';
import 'katex/dist/katex.min.css';
import './globals.css';

installClientFetchWrapper({ pathPrefix: wikiPrefix() });

installClientLogForwarder();

void requestStoragePersistence();

if (shouldInstallColdMountInstrumentation()) {
  installColdMountInstrumentation();
}
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  initWebVitals();
}

installSubscribeCardStore();

installContactEmailStore();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000 },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey="ok-theme-v1"
        >
          <TooltipProvider>
            <AppErrorBoundary>
              <App />
            </AppErrorBoundary>
            <Toaster richColors closeButton />
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
