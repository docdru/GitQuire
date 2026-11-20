import { beforeEach, describe, expect, test, vi } from 'vitest';

const requestDocPanelTab = vi.hoisted(() => vi.fn());
vi.mock('@/components/doc-panel-events', () => ({ requestDocPanelTab }));

import type { Anchor } from './thread-ops';
import {
  clearDraft,
  getDiscussionUi,
  openCommentsPane,
  openThread,
  revealDiscussion,
  setActiveThread,
  showThreadInPane,
  startDraft,
} from './ui-store';

const anchor: Anchor = { exact: 'quoted' };

beforeEach(() => {
  clearDraft();
  setActiveThread(null);
  requestDocPanelTab.mockClear();
});

describe('a thread opens beside its text', () => {
  test('opening a thread does not open the side pane', () => {
    openThread('page', 'thread-1');
    expect(getDiscussionUi()).toMatchObject({ docName: 'page', activeThreadId: 'thread-1' });
    expect(requestDocPanelTab).not.toHaveBeenCalled();
  });

  test('opening a thread drops an unsent new comment', () => {
    startDraft('page', { anchor, from: 1, to: 7 });
    openThread('page', 'thread-1');
    expect(getDiscussionUi()).toMatchObject({ activeThreadId: 'thread-1', draft: null });
  });

  test('starting a comment does not open the side pane', () => {
    startDraft('page', { anchor, from: 1, to: 7 });
    expect(getDiscussionUi()).toMatchObject({ activeThreadId: null, draft: { from: 1, to: 7 } });
    expect(requestDocPanelTab).not.toHaveBeenCalled();
  });

  test('a mention reveals its thread', () => {
    revealDiscussion('page', 'thread-2');
    expect(getDiscussionUi()).toMatchObject({
      activeThreadId: 'thread-2',
      revealThreadId: 'thread-2',
    });
    expect(requestDocPanelTab).not.toHaveBeenCalled();
  });
});

describe('the list lives in the side pane', () => {
  test('opening the list asks for the Comments tab', () => {
    openCommentsPane();
    expect(requestDocPanelTab).toHaveBeenCalledWith('comments');
  });

  test('a thread whose text is gone is shown in the pane', () => {
    showThreadInPane('page', 'thread-3');
    expect(getDiscussionUi()).toMatchObject({ docName: 'page', activeThreadId: 'thread-3' });
    expect(requestDocPanelTab).toHaveBeenCalledWith('comments');
  });
});
