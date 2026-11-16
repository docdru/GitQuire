import { MathInline as BaseMathInline } from '@gitquire/core/extensions/math-inline';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MathInlineView } from './MathInlineView';

export const MathInline = BaseMathInline.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView, { trackNodeViewPosition: true });
  },
});
