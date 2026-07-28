// Firefox Bookmark Event Listeners

import browser, { Bookmarks } from 'webextension-polyfill';
import {
  getSettings,
  findMappingByFirefoxId,
  findBookmarkLink,
  isAuthenticated,
} from './storage';
import { logger } from '../utils/logger';
import { computeBookmarkHash, isValidSyncUrl } from '../utils/hash';
import { isBookmarkNode } from '../utils/bookmarkNode';

// Track operations to avoid duplicates during sync
// Uses a depth counter instead of boolean to handle concurrent syncs correctly:
// if two sync processes run in parallel, the first to finish won't prematurely
// reset the flag while the second is still running.
let syncDepth = 0;

export function setSyncing(value: boolean): void {
  if (value) {
    syncDepth++;
  } else {
    syncDepth = Math.max(0, syncDepth - 1);
  }
}

export function isSyncInProgress(): boolean {
  return syncDepth > 0;
}

// ==================== Debounced reconcile trigger (task 014) ====================

// One debounced trigger for every relevant bookmark event. The event itself
// carries no payload anymore — reconcile re-derives everything from the
// three-way diff. Trailing debounce: a burst (import, drag of many) collapses
// into one pass. If the MV3 SW dies before the timer fires, the periodic alarm
// reconcile catches up (same guarantee the old queue had).
const RECONCILE_DEBOUNCE_MS = 800;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconcile(): void {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    // Dynamic import breaks the module cycle (syncManager imports setSyncing).
    void import('./syncManager')
      .then((m) => m.reconcileAllMappings())
      .catch((error) => logger.error('Debounced reconcile failed', error));
  }, RECONCILE_DEBOUNCE_MS);
}

// Shared cheap gate for every handler: never react to our own sync writes, and
// only when connected + auto-sync on.
async function syncActive(): Promise<boolean> {
  if (isSyncInProgress()) return false;
  const [authenticated, settings] = await Promise.all([
    isAuthenticated(),
    getSettings(),
  ]);
  return authenticated && settings.enabled;
}

// ==================== Event Listeners ====================

async function handleBookmarkCreated(
  id: string,
  bookmark: Bookmarks.BookmarkTreeNode
): Promise<void> {
  if (isSyncInProgress()) return;
  if (!isBookmarkNode(bookmark)) return;
  if (!isValidSyncUrl(bookmark.url!)) return;
  if (!(await syncActive())) return;

  const parentId = bookmark.parentId;
  if (!parentId) return;
  if (!(await hasSyncedAncestor(parentId))) {
    logger.debug('Created bookmark has no synced ancestor, ignoring');
    return;
  }

  logger.info(`Bookmark created in synced tree: ${bookmark.title}`);
  scheduleReconcile();
}

async function handleBookmarkRemoved(
  id: string,
  _removeInfo: Bookmarks.OnRemovedRemoveInfoType
): Promise<void> {
  if (!(await syncActive())) return;

  // Relevant if a linked bookmark, or a mapped folder itself, was removed.
  const link = await findBookmarkLink(id);
  const mapping = link ? null : await findMappingByFirefoxId(id);
  if (!link && !mapping) {
    logger.debug('Removed node is neither linked nor a mapped folder, ignoring');
    return;
  }

  logger.info(`Removal in synced scope: ${link?.title ?? mapping?.folderName}`);
  scheduleReconcile();
}

async function handleBookmarkChanged(
  id: string,
  changeInfo: Bookmarks.OnChangedChangeInfoType
): Promise<void> {
  if (!(await syncActive())) return;

  const link = await findBookmarkLink(id);
  if (link) {
    // Skip a no-op change (content hash unchanged) — avoids a pointless pass.
    const newTitle = changeInfo.title || link.title;
    const newUrl = changeInfo.url || link.url;
    if (computeBookmarkHash(newUrl, newTitle) === link.contentHash) {
      logger.debug('Content hash unchanged, ignoring change event');
      return;
    }
    logger.info(`Bookmark changed: ${newTitle}`);
    scheduleReconcile();
    return;
  }

  // A mapped folder rename (onChanged fires with the new title). Reconcile's
  // three-way rename handles it; the periodic pass also detects renames, so
  // this is a best-effort fast path.
  if (await findMappingByFirefoxId(id)) {
    logger.info('Mapped folder renamed');
    scheduleReconcile();
  }
}

// Walk up the browser folder tree from `folderId`, returning true as soon as an
// ancestor (or the folder itself) is a mapped, synced folder. Used to tell an
// intra-tree move/create inside a not-yet-mapped subfolder from a genuine one
// outside every synced tree. Capped by MAX_ANCESTOR_WALK against a pathological
// tree.
//
// The cap is intentionally independent of (and looser than) syncManager's
// MAX_SYNC_DEPTH — importing that constant here would create a module cycle
// (syncManager already imports setSyncing from this file). A subfolder deeper
// than MAX_SYNC_DEPTH is never mapped by reconcile anyway, so deferring its
// handling only means the raindrop lingers in the old collection (data
// preserved) rather than being deleted+recreated with a new _id — the safer
// failure for a depth no realistic tree reaches.
const MAX_ANCESTOR_WALK = 50;

async function hasSyncedAncestor(folderId: string): Promise<boolean> {
  let currentId: string | undefined = folderId;
  for (let i = 0; i < MAX_ANCESTOR_WALK && currentId; i++) {
    if (await findMappingByFirefoxId(currentId)) {
      return true;
    }
    try {
      const [node] = await browser.bookmarks.get(currentId);
      currentId = node?.parentId;
    } catch {
      // Can't verify ancestry → fail closed: assume in-tree and reconcile. A
      // missed sync is recoverable on a later pass; a wrong skip could drop a
      // move that should have propagated.
      return true;
    }
  }
  return false;
}

async function handleBookmarkMoved(
  id: string,
  moveInfo: Bookmarks.OnMovedMoveInfoType
): Promise<void> {
  if (!(await syncActive())) return;

  // Relevant if the bookmark is already linked, or either end of the move is
  // within a synced tree. Reconcile re-derives the actual push/pull/move/delete
  // (including "moved out of scope → delete the raindrop") from the diff — the
  // event only decides whether a pass is worth running.
  const link = await findBookmarkLink(id);
  if (link) {
    scheduleReconcile();
    return;
  }
  if (
    (await hasSyncedAncestor(moveInfo.oldParentId)) ||
    (await hasSyncedAncestor(moveInfo.parentId))
  ) {
    scheduleReconcile();
    return;
  }
  logger.debug('Move touches no synced tree, ignoring');
}

// ==================== Listener Management ====================

let listenersRegistered = false;

export function registerBookmarkListeners(): void {
  if (listenersRegistered) {
    logger.debug('Bookmark listeners already registered');
    return;
  }

  browser.bookmarks.onCreated.addListener(handleBookmarkCreated);
  browser.bookmarks.onRemoved.addListener(handleBookmarkRemoved);
  browser.bookmarks.onChanged.addListener(handleBookmarkChanged);
  browser.bookmarks.onMoved.addListener(handleBookmarkMoved);

  listenersRegistered = true;
  logger.info('Bookmark listeners registered');
}

export function unregisterBookmarkListeners(): void {
  if (!listenersRegistered) {
    return;
  }

  browser.bookmarks.onCreated.removeListener(handleBookmarkCreated);
  browser.bookmarks.onRemoved.removeListener(handleBookmarkRemoved);
  browser.bookmarks.onChanged.removeListener(handleBookmarkChanged);
  browser.bookmarks.onMoved.removeListener(handleBookmarkMoved);

  // Cancel any armed reconcile. Every teardown path (disable auto-sync,
  // disconnect/blank-slate, last mapping removed) calls this, so a pending
  // timer must not fire afterwards: reconcileAllMappings has no enabled gate,
  // so a late pass would push/pull after the user disabled sync (task 007) or
  // write into freshly-wiped storage after disconnect (task 011).
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }

  listenersRegistered = false;
  logger.info('Bookmark listeners unregistered');
}
