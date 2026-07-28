// Bookmark tree node predicates shared across sync code.

import type { Bookmarks } from 'webextension-polyfill';

/**
 * Unified folder detection (task 001, bug #5).
 *
 * Firefox sets `type: 'folder'`, but Chrome often omits `type` entirely —
 * so a folder is "anything without a URL that isn't a separator".
 * Never check `node.type === 'folder'` directly.
 */
export function isFolderNode(node: Bookmarks.BookmarkTreeNode): boolean {
  return !node.url && node.type !== 'separator';
}

/**
 * Unified bookmark detection: Firefox sets `type: 'bookmark'`, Chrome
 * often omits `type` — so a bookmark is "has a URL and type is either
 * 'bookmark' or absent".
 */
export function isBookmarkNode(node: Bookmarks.BookmarkTreeNode): boolean {
  return !!node.url && (node.type === 'bookmark' || node.type === undefined);
}
