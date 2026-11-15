import { type RefObject, useEffect } from 'react';
import {
  publishSelectionContext,
  selectionSnapshotFromFrontmatter,
} from '@/editor/selection-context';

function readFrontmatterSelection(container: HTMLElement): string {
  const active = document.activeElement as
    | (Element & { selectionStart?: number | null; selectionEnd?: number | null; value?: string })
    | null;
  if (active && container.contains(active) && typeof active.value === 'string') {
    const { selectionStart, selectionEnd, value } = active;
    if (
      selectionStart != null &&
      selectionEnd != null &&
      selectionEnd > selectionStart &&
      typeof value === 'string'
    ) {
      return value.slice(selectionStart, selectionEnd);
    }
  }
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  const node =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  if (!node || !container.contains(node)) return '';
  return sel.toString();
}

export function usePublishFrontmatterSelection(
  containerRef: RefObject<HTMLElement | null>,
  docName: string,
): void {
  useEffect(() => {
    if (typeof document === 'undefined' || docName === '') return;
    const onSelectionChange = () => {
      const container = containerRef.current;
      if (!container) return;
      const text = readFrontmatterSelection(container);
      publishSelectionContext(
        docName,
        'frontmatter',
        text === '' ? null : selectionSnapshotFromFrontmatter(text, docName),
      );
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      publishSelectionContext(docName, 'frontmatter', null);
    };
  }, [containerRef, docName]);
}
