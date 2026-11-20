export const EDITOR_OVERLAY_HOST_ATTR = 'data-gitquire-editor-overlay-host';

export function editorOverlayHost(inside: Element | null): HTMLElement {
  return inside?.closest<HTMLElement>(`[${EDITOR_OVERLAY_HOST_ATTR}]`) ?? document.body;
}
