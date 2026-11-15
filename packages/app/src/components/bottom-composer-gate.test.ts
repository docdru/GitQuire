import { describe, expect, test } from 'vitest';
import {
  type BottomComposerGateInputs,
  shouldShowBottomComposer,
  shouldShowFolderComposer,
} from './bottom-composer-gate';

const PASSING: BottomComposerGateInputs = {
  agentsVisible: false,
  isEmbedded: false,
  activeDocName: 'notes',
};

describe('shouldShowBottomComposer', () => {
  test('renders when not embedded, both panels closed, and a doc is open', () => {
    expect(shouldShowBottomComposer(PASSING)).toBe(true);
  });

  describe('each gate input independently hides the composer', () => {
    test('hidden when the agents panel is open', () => {
      expect(shouldShowBottomComposer({ ...PASSING, agentsVisible: true })).toBe(false);
    });

    test('hidden when the host is embedded', () => {
      expect(shouldShowBottomComposer({ ...PASSING, isEmbedded: true })).toBe(false);
    });

    test('hidden when no document is open', () => {
      expect(shouldShowBottomComposer({ ...PASSING, activeDocName: null })).toBe(false);
    });
  });

  test('stays hidden when several inputs fail at once', () => {
    expect(
      shouldShowBottomComposer({
        agentsVisible: true,
        isEmbedded: true,
        activeDocName: null,
      }),
    ).toBe(false);
  });
});

describe('shouldShowFolderComposer', () => {
  const PASSING_FOLDER = { agentsVisible: false, isEmbedded: false };

  test('renders when not embedded and both panels closed (no doc required)', () => {
    expect(shouldShowFolderComposer(PASSING_FOLDER)).toBe(true);
  });

  test('hidden when the agents panel is open', () => {
    expect(shouldShowFolderComposer({ ...PASSING_FOLDER, agentsVisible: true })).toBe(false);
  });

  test('hidden when the host is embedded', () => {
    expect(shouldShowFolderComposer({ ...PASSING_FOLDER, isEmbedded: true })).toBe(false);
  });
});
