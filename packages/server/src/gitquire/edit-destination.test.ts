import { describe, expect, it } from 'vitest';
import { editDestinationNote, withEditDestination } from './edit-destination.ts';

describe('where an edit went', () => {
  it('names the draft an edit went into', () => {
    expect(
      editDestinationNote({ GITQUIRE_DRAFT: 'plan', GITQUIRE_DRAFT_TITLE: 'Q3 plan' }, true),
    ).toBe(
      'This change is in the draft "Q3 plan", not in the live wiki. It goes live when someone publishes the draft.',
    );
  });

  it('says an edit went to the live wiki when drafts are on', () => {
    expect(editDestinationNote({}, true)).toBe(
      'This change is in the live wiki, which everyone sees.',
    );
    expect(editDestinationNote({}, false)).toBeUndefined();
  });

  it('adds the note to the text an assistant reads', () => {
    const result = withEditDestination(
      {
        content: [{ type: 'text', text: 'Wrote notes.md' }],
        structuredContent: { text: 'Wrote notes.md', ok: true },
      },
      'This change is in the live wiki, which everyone sees.',
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'Wrote notes.md\n\nThis change is in the live wiki, which everyone sees.',
        },
      ],
      structuredContent: {
        text: 'Wrote notes.md\n\nThis change is in the live wiki, which everyone sees.',
        ok: true,
      },
    });
  });

  it('leaves failures alone', () => {
    const failed = { isError: true, content: [{ type: 'text', text: 'Error: nope' }] };
    expect(withEditDestination(failed, 'note')).toBe(failed);
  });
});
