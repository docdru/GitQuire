import { ImageReferenceFidelity } from '@gitquire/core/extensions/image-reference-fidelity';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageReferenceView } from './ImageReferenceView';

export const ImageReference = ImageReferenceFidelity.extend<{ docName: string }>({
  addOptions() {
    return {
      ...this.parent?.(),
      docName: '',
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageReferenceView, { trackNodeViewPosition: true });
  },
});
