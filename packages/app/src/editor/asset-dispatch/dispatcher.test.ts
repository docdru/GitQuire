import { beforeEach, describe, expect, test, vi } from 'vitest';
import { dispatchAssetClick } from './dispatcher.ts';
import { AssetViewerRegistry, assetViewerRegistry } from './registry.ts';
import type { AssetClickContext } from './types.ts';

function ctx(overrides: Partial<AssetClickContext> = {}): AssetClickContext {
  return {
    url: './meeting.pdf',
    projectRelPath: 'notes/meeting.pdf',
    ext: 'pdf',
    title: 'meeting.pdf',
    forceOsDelegation: false,
    ...overrides,
  };
}

describe('dispatchAssetClick', () => {
  beforeEach(() => {
    assetViewerRegistry.clearForTests();
  });

  test('empty registry + no desktop bridge → web fallback fires with url', async () => {
    const openUrl = vi.fn((_: string) => {});
    await dispatchAssetClick(ctx({ url: './meeting.pdf' }), {
      desktopBridge: undefined,
      openUrl,
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('./meeting.pdf');
  });

  test('registered viewer for ext fires with the context', async () => {
    const openUrl = vi.fn((_: string) => {});
    const viewer = { exts: ['pdf'] as const, render: vi.fn(() => {}) };
    const r = new AssetViewerRegistry();
    r.register(viewer);

    const context = ctx();
    await dispatchAssetClick(context, { registry: r, desktopBridge: undefined, openUrl });

    expect(viewer.render).toHaveBeenCalledTimes(1);
    expect(viewer.render).toHaveBeenCalledWith(context);
    expect(openUrl).not.toHaveBeenCalled();
  });

  test('Cmd/Ctrl+click bypasses a registered viewer (D-A6)', async () => {
    const openUrl = vi.fn((_: string) => {});
    const viewer = { exts: ['pdf'] as const, render: vi.fn(() => {}) };
    const r = new AssetViewerRegistry();
    r.register(viewer);

    await dispatchAssetClick(ctx({ forceOsDelegation: true }), {
      registry: r,
      desktopBridge: undefined,
      openUrl,
    });

    expect(viewer.render).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  test('dispatcher uses the module-level singleton registry when no deps passed', async () => {
    const viewer = { exts: ['pdf'] as const, render: vi.fn(() => {}) };
    assetViewerRegistry.register(viewer);

    const openUrl = vi.fn((_: string) => {});
    await dispatchAssetClick(ctx(), { desktopBridge: undefined, openUrl });

    expect(viewer.render).toHaveBeenCalledTimes(1);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
