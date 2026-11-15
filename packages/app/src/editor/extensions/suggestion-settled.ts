import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

export interface SuggestionRenderer<I, S> {
  onBeforeStart?: (props: SuggestionProps<I, S>) => void;
  onStart?: (props: SuggestionProps<I, S>) => void;
  onBeforeUpdate?: (props: SuggestionProps<I, S>) => void;
  onUpdate?: (props: SuggestionProps<I, S>) => void;
  onExit?: (props: SuggestionProps<I, S>) => void;
  onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
}

export function settledSuggestionRender<I, S = I>(
  render: () => SuggestionRenderer<I, S>,
): () => SuggestionRenderer<I, S> {
  return () => {
    const inner = render();
    let started = false;
    return {
      ...inner,
      onStart(props) {
        if (props.loading) return;
        started = true;
        inner.onStart?.(props);
      },
      onUpdate(props) {
        if (props.loading) return;
        if (!started) {
          started = true;
          inner.onStart?.(props);
          return;
        }
        inner.onUpdate?.(props);
      },
      onKeyDown(props) {
        if (!started) return false;
        return inner.onKeyDown?.(props) ?? false;
      },
      onExit(props) {
        started = false;
        inner.onExit?.(props);
      },
    };
  };
}
