import { beforeEach, describe, expect, test } from 'vitest';
import type { Anchor } from './thread-ops';
import {
  clearDraft,
  closeDiscussions,
  getDiscussionUi,
  openDiscussions,
  revealDiscussion,
  setActiveThread,
  showThreadInList,
  startDraft,
} from './ui-store';

const anchor: Anchor = { exact: 'quoted' };

beforeEach(() => {
  closeDiscussions();
  clearDraft();
  setActiveThread(null);
});

describe('a thread opens beside its text, not in the list', () => {
  test('opening a thread leaves the list closed', () => {
    openDiscussions('page', 'thread-1');
    expect(getDiscussionUi()).toMatchObject({ open: false, activeThreadId: 'thread-1' });
  });

  test('opening a thread keeps an open list open', () => {
    openDiscussions('page');
    openDiscussions('page', 'thread-1');
    expect(getDiscussionUi()).toMatchObject({ open: true, activeThreadId: 'thread-1' });
  });

  test('the Comments button opens the list', () => {
    openDiscussions('page');
    expect(getDiscussionUi()).toMatchObject({ open: true, activeThreadId: null });
  });

  test('starting a comment leaves the list closed', () => {
    startDraft('page', { anchor, from: 1, to: 7 });
    expect(getDiscussionUi()).toMatchObject({ open: false, draft: { from: 1, to: 7 } });
  });

  test('a mention reveals its thread without opening the list', () => {
    revealDiscussion('page', 'thread-2');
    expect(getDiscussionUi()).toMatchObject({
      open: false,
      activeThreadId: 'thread-2',
      revealThreadId: 'thread-2',
    });
  });

  test('closing the list keeps the open thread', () => {
    openDiscussions('page');
    setActiveThread('thread-1');
    closeDiscussions();
    expect(getDiscussionUi()).toMatchObject({ open: false, activeThreadId: 'thread-1' });
  });

  test('a thread whose text is gone is shown in the list', () => {
    showThreadInList('page', 'thread-3');
    expect(getDiscussionUi()).toMatchObject({ open: true, activeThreadId: 'thread-3' });
  });

  test('a list from another page does not carry over', () => {
    openDiscussions('other');
    openDiscussions('page', 'thread-1');
    expect(getDiscussionUi()).toMatchObject({ docName: 'page', open: false });
  });
});
