import Image from '@tiptap/extension-image';
import { renderInlineObjectText } from './input-rule-text.ts';

export const ImageSrcFidelity = Image.extend({
  marks: '_',
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceUrl: { default: null, rendered: false },
      sourceUrlForm: { default: null, rendered: false },
    };
  },
});
