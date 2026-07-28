import { describe, it, expect } from 'vitest';
import type { Bookmarks } from 'webextension-polyfill';
import { isBookmarkNode, isFolderNode } from './bookmarkNode';

function node(partial: Partial<Bookmarks.BookmarkTreeNode>): Bookmarks.BookmarkTreeNode {
  return { id: 'x', title: 'Node', ...partial } as Bookmarks.BookmarkTreeNode;
}

describe('isFolderNode', () => {
  it('detects a Firefox folder (type: "folder", no url)', () => {
    expect(isFolderNode(node({ type: 'folder' }))).toBe(true);
  });

  it('detects a Chrome folder (type undefined, no url)', () => {
    // In Chrome, folders often have no `type` property at all — the old
    // `child.type === 'folder'` check missed them (task 001, bug #5).
    expect(isFolderNode(node({}))).toBe(true);
  });

  it('rejects a Firefox bookmark (type: "bookmark", has url)', () => {
    expect(isFolderNode(node({ type: 'bookmark', url: 'https://example.com' }))).toBe(false);
  });

  it('rejects a Chrome bookmark (type undefined, has url)', () => {
    expect(isFolderNode(node({ url: 'https://example.com' }))).toBe(false);
  });

  it('rejects a separator (type: "separator", no url)', () => {
    expect(isFolderNode(node({ type: 'separator' }))).toBe(false);
  });
});

describe('isBookmarkNode', () => {
  it('detects a Firefox bookmark (type: "bookmark", has url)', () => {
    expect(isBookmarkNode(node({ type: 'bookmark', url: 'https://example.com' }))).toBe(true);
  });

  it('detects a Chrome bookmark (type undefined, has url)', () => {
    expect(isBookmarkNode(node({ url: 'https://example.com' }))).toBe(true);
  });

  it('rejects folders (no url)', () => {
    expect(isBookmarkNode(node({ type: 'folder' }))).toBe(false);
    expect(isBookmarkNode(node({}))).toBe(false);
  });

  it('rejects a node with url but a non-bookmark type', () => {
    expect(isBookmarkNode(node({ type: 'separator', url: 'https://example.com' }))).toBe(false);
  });
});
