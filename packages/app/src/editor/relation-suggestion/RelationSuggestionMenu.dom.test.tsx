import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RelationSuggestionMenu } from './RelationSuggestionMenu';

describe('RelationSuggestionMenu', () => {
  afterEach(cleanup);

  test('shows nothing when no relation names are known', () => {
    const { container } = render(
      <RelationSuggestionMenu
        items={[]}
        query="bl"
        selectedIndex={0}
        onSelect={vi.fn()}
        known={0}
      />,
    );
    expect(container.textContent).toBe('');
  });

  test('says when known names do not match', () => {
    const { getByTestId } = render(
      <RelationSuggestionMenu
        items={[]}
        query="xy"
        selectedIndex={0}
        onSelect={vi.fn()}
        known={3}
      />,
    );
    expect(getByTestId('relation-suggestion-empty').textContent).toContain('"xy"');
  });

  test('lists the names with their counts', () => {
    const { getByTestId } = render(
      <RelationSuggestionMenu
        items={[{ name: 'blocks', count: 3 }]}
        query="bl"
        selectedIndex={0}
        onSelect={vi.fn()}
        known={1}
      />,
    );
    expect(getByTestId('relation-suggestion-blocks').getAttribute('aria-selected')).toBe('true');
  });
});
