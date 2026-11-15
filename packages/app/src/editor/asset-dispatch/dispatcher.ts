import { type AssetViewerRegistry, assetViewerRegistry } from './registry.ts';
import type { AssetClickContext } from './types.ts';

interface DispatchAssetClickDeps {
  readonly registry?: AssetViewerRegistry;
  readonly openUrl?: (url: string) => void;
}

function defaultOpenAssetTab(url: string): void {
  globalThis.window?.open(url, '_blank', 'noopener,noreferrer');
}

export async function dispatchAssetClick(
  ctx: AssetClickContext,
  deps: DispatchAssetClickDeps = {},
): Promise<void> {
  const registry = deps.registry ?? assetViewerRegistry;
  const openUrl = deps.openUrl ?? defaultOpenAssetTab;

  if (!ctx.forceOsDelegation) {
    const lookup = registry.lookup(ctx.ext);
    if (lookup.ok) {
      lookup.viewer.render(ctx);
      return;
    }
  }

  openUrl(ctx.url);
}
