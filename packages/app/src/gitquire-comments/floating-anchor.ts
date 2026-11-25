import {
  autoUpdate,
  type ClientRectObject,
  computePosition,
  flip,
  hide,
  offset,
  shift,
  size,
} from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';
import { type CSSProperties, type RefObject, useLayoutEffect } from 'react';

const EDGE_PADDING = 8;
const MIN_HEIGHT = 160;

export const UNPLACED_STYLE: CSSProperties = {
  left: 0,
  top: 0,
  opacity: 0,
  pointerEvents: 'none',
};

export interface TextRange {
  from: number;
  to: number;
}

const EMPTY_RECT: ClientRectObject = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

export function rangeRect(editor: Editor, range: TextRange): ClientRectObject {
  if (editor.isDestroyed) return EMPTY_RECT;
  const max = editor.state.doc.content.size;
  const from = Math.max(0, Math.min(range.from, max));
  const to = Math.max(from, Math.min(range.to, max));
  try {
    const start = editor.view.coordsAtPos(from, 1);
    const end = editor.view.coordsAtPos(to, -1);
    const sameLine = Math.abs(start.top - end.top) < 2;
    const left = sameLine ? Math.min(start.left, end.left) : start.left;
    const right = sameLine ? Math.max(start.right, end.right) : start.left;
    const top = start.top;
    const bottom = Math.max(start.bottom, end.bottom);
    return {
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  } catch {
    return EMPTY_RECT;
  }
}

export function useFloatingAnchor(
  editor: Editor,
  range: TextRange | null,
  floating: RefObject<HTMLElement | null>,
): void {
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  useLayoutEffect(() => {
    const element = floating.current;
    if (element === null || from === null || to === null || editor.isDestroyed) return;
    const reference = {
      contextElement: editor.view.dom,
      getBoundingClientRect: () => rangeRect(editor, { from, to }),
    };
    const update = (): void => {
      void computePosition(reference, element, {
        strategy: 'fixed',
        placement: 'bottom-start',
        middleware: [
          offset(EDGE_PADDING),
          flip({ padding: EDGE_PADDING }),
          shift({ padding: EDGE_PADDING }),
          size({
            padding: EDGE_PADDING,
            apply({ availableHeight, elements }) {
              elements.floating.style.maxHeight = `${Math.max(MIN_HEIGHT, availableHeight)}px`;
            },
          }),
          hide(),
        ],
      }).then(({ x, y, middlewareData }) => {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        element.style.opacity = '';
        element.style.pointerEvents = '';
        element.style.visibility = middlewareData.hide?.referenceHidden ? 'hidden' : 'visible';
      });
    };
    return autoUpdate(reference, element, update);
  }, [editor, floating, from, to]);
}
