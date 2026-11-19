/**
 * Exercises `render` + `userEvent` under the jsdom substrate (precedent #43). Throw injection
 * follows the MaybeThrow Pattern C documented in precedent #43(d).
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as syncPromiseModule from '@/editor/sync-promise';
import { DocumentErrorBoundary, errorCopy } from './DocumentErrorBoundary';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

let shouldThrow = false;

function MaybeThrow({ label }: { label: string }) {
  if (shouldThrow) {
    throw new Error(`MaybeThrow boom: ${label}`);
  }
  return <span data-testid="payload">{label}</span>;
}

describe('DocumentErrorBoundary (Tier-3 mount)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow = false;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('renders children when no throw', () => {
    const onRecycle = vi.fn(() => {});
    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <MaybeThrow label="hello" />
      </DocumentErrorBoundary>,
    );
    expect(screen.getByTestId('payload').textContent).toBe('hello');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onRecycle).not.toHaveBeenCalled();
  });

  test('renders fallback UI with role=alert + heading + try-again button on child throw', () => {
    shouldThrow = true;
    const onRecycle = vi.fn(() => {});
    const error = new Error('MaybeThrow boom: alpha');
    const { title } = errorCopy(error);

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-slot')).toBe('document-error-boundary');

    const heading = document.getElementById('document-error-title');
    expect(heading?.textContent).toBe(title);

    const tryAgain = screen.getByRole('button', { name: /try again/i });
    expect(tryAgain.tagName).toBe('BUTTON');

    expect(screen.queryByRole('button', { name: /go back/i })).toBeNull();
  });

  test('Try again invokes onRecycle BEFORE the bracket-prefix retry log fires', async () => {
    shouldThrow = true;
    const callOrder: string[] = [];
    const onRecycle = vi.fn((docName: string) => {
      callOrder.push(`recycle:${docName}`);
    });
    consoleWarnSpy.mockImplementation((message: unknown) => {
      if (typeof message === 'string') callOrder.push(`warn:${message}`);
    });

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRecycle).toHaveBeenCalledTimes(1);
    expect(onRecycle.mock.calls[0]?.[0]).toBe('alpha.md');

    const recycleIdx = callOrder.findIndex((entry) => entry.startsWith('recycle:'));
    const warnIdx = callOrder.findIndex((entry) =>
      entry.startsWith('warn:[DocumentErrorBoundary] retry recycled'),
    );
    expect(recycleIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThan(recycleIdx);
  });

  test('renders Go back button when previousDocName + onNavigateBack are both set', () => {
    shouldThrow = true;
    const onRecycle = vi.fn(() => {});
    const onNavigateBack = vi.fn(() => {});

    render(
      <DocumentErrorBoundary
        activeDocName="alpha.md"
        previousDocName="beta.md"
        onNavigateBack={onNavigateBack}
        onRecycle={onRecycle}
      >
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /go back/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined();
  });

  test('Go back click navigates with previousDocName, invalidates sync promise, and does NOT call onRecycle', async () => {
    shouldThrow = true;
    const onRecycle = vi.fn((_docName: string) => {});
    const onNavigateBack = vi.fn((_previousDocName: string) => {});
    const invalidateSpy = vi
      .spyOn(syncPromiseModule, 'invalidateSyncPromise')
      .mockImplementation(() => {});

    render(
      <DocumentErrorBoundary
        activeDocName="alpha.md"
        previousDocName="beta.md"
        onNavigateBack={onNavigateBack}
        onRecycle={onRecycle}
      >
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /go back/i }));

    expect(onNavigateBack).toHaveBeenCalledTimes(1);
    expect(onNavigateBack.mock.calls[0]?.[0]).toBe('beta.md');
    expect(onRecycle).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy.mock.calls[0]?.[0]).toBe('alpha.md');

    const sawBackNavWarn = consoleWarnSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      return typeof message === 'string' && message.includes('back-nav reset (no recycle)');
    });
    expect(sawBackNavWarn).toBe(true);

    invalidateSpy.mockRestore();
  });

  test('offers no report action', () => {
    shouldThrow = true;
    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={vi.fn(() => {})}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /try again/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /report this error/i })).toBeNull();
  });

  test('onError logs bracket-prefix console.error including the doc name and error title', () => {
    shouldThrow = true;
    const onRecycle = vi.fn(() => {});
    const error = new Error('MaybeThrow boom: alpha');
    const { title } = errorCopy(error);

    render(
      <DocumentErrorBoundary activeDocName="alpha.md" onRecycle={onRecycle}>
        <MaybeThrow label="alpha" />
      </DocumentErrorBoundary>,
    );

    const sawBoundaryError = consoleErrorSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      return (
        typeof message === 'string' &&
        message.includes('[DocumentErrorBoundary]') &&
        message.includes('alpha.md') &&
        message.includes(title)
      );
    });
    expect(sawBoundaryError).toBe(true);
  });
});
