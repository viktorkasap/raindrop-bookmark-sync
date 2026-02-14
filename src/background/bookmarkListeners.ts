// Firefox Bookmark Event Listeners

import browser, { Bookmarks } from 'webextension-polyfill';
import { SyncOperation } from '../types/storage';
import {
  getSettings,
  findMappingByFirefoxId,
  findBookmarkLink,
  findBookmarkLinkByUrl,
  addToQueue,
  isAuthenticated,
} from './storage';
import { logger } from '../utils/logger';
import { generateId, computeBookmarkHash, isValidSyncUrl } from '../utils/hash';

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

// Per-key queue batching: accumulates operations by firefoxId,
// keeping only the latest operation per bookmark. Flushes after 300ms pause.
// This prevents losing events when multiple bookmarks change rapidly.
const pendingOperations = new Map<string, SyncOperation>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleQueueFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const operations = Array.from(pendingOperations.values());
    pendingOperations.clear();
    for (const op of operations) {
      await addToQueue(op);
    }
  }, 300);
}

function batchAddToQueue(operation: SyncOperation): void {
  const key = operation.data.firefoxId || operation.id;
  pendingOperations.set(key, operation);
  scheduleQueueFlush();
}

// ==================== Event Listeners ====================

async function handleBookmarkCreated(
  id: string,
  bookmark: Bookmarks.BookmarkTreeNode
): Promise<void> {
  // Skip if syncing is in progress (to avoid loops)
  if (isSyncInProgress()) {
    logger.debug('Skipping bookmark created event during sync');
    return;
  }

  // Skip folders and separators
  // In Chrome, type may be undefined for bookmarks - they have url property instead
  // In Firefox, type is 'bookmark' for bookmarks and 'folder' for folders
  const isBookmark = bookmark.url && (bookmark.type === 'bookmark' || bookmark.type === undefined);
  if (!isBookmark) {
    logger.debug('Skipping non-bookmark item', { type: bookmark.type, hasUrl: !!bookmark.url });
    return;
  }

  // Skip internal browser URLs (about:, chrome:, etc.)
  if (!isValidSyncUrl(bookmark.url!)) {
    logger.debug(`Skipping invalid URL: ${bookmark.url}`);
    return;
  }

  // Check auth and settings
  const authenticated = await isAuthenticated();
  const settings = await getSettings();
  if (!authenticated || !settings.enabled) {
    logger.debug('Sync is disabled or not authenticated, skipping');
    return;
  }

  // Check if bookmark is in a synced folder
  const parentId = bookmark.parentId;
  if (!parentId) {
    logger.debug('Bookmark has no parent');
    return;
  }

  const mapping = await findMappingByFirefoxId(parentId);
  if (!mapping) {
    logger.debug('Parent folder is not synced');
    return;
  }

  // Check if this bookmark was already synced (e.g., created by pull sync).
  // This prevents duplicates when the onCreated event fires after setSyncing(false).
  // Check both by firefoxId AND by URL — in Chrome MV3 the Service Worker can be
  // killed between bookmark creation and link saving, losing the firefoxId link.
  const existingLink = await findBookmarkLink(id);
  if (existingLink) {
    logger.debug('Link already exists for this bookmark, skipping create event');
    return;
  }
  const existingLinkByUrl = await findBookmarkLinkByUrl(bookmark.url!);
  if (existingLinkByUrl) {
    logger.debug('Link already exists for this URL, skipping create event');
    return;
  }

  logger.info(`Bookmark created in synced folder: ${bookmark.title}`);

  const operation: SyncOperation = {
    id: generateId(),
    type: 'create',
    source: 'firefox',
    entityType: 'bookmark',
    data: {
      firefoxId: id,
      url: bookmark.url,
      title: bookmark.title,
      collectionId: mapping.raindropCollectionId,
      mappingId: mapping.id,
    },
    timestamp: Date.now(),
    retries: 0,
    maxRetries: 3,
  };

  batchAddToQueue(operation);
}

async function handleBookmarkRemoved(
  id: string,
  removeInfo: Bookmarks.OnRemovedRemoveInfoType
): Promise<void> {
  // Skip if syncing is in progress
  if (isSyncInProgress()) {
    logger.debug('Skipping bookmark removed event during sync');
    return;
  }

  // Check auth and settings
  const authenticated = await isAuthenticated();
  const settings = await getSettings();
  if (!authenticated || !settings.enabled) {
    return;
  }

  // Find the bookmark link
  const link = await findBookmarkLink(id);
  if (!link) {
    logger.debug('No link found for removed bookmark');
    return;
  }

  logger.info(`Bookmark removed: ${link.title}`);

  const operation: SyncOperation = {
    id: generateId(),
    type: 'delete',
    source: 'firefox',
    entityType: 'bookmark',
    data: {
      firefoxId: id,
      raindropId: link.raindropId,
      mappingId: link.mappingId,
    },
    timestamp: Date.now(),
    retries: 0,
    maxRetries: 3,
  };

  batchAddToQueue(operation);
}

async function handleBookmarkChanged(
  id: string,
  changeInfo: Bookmarks.OnChangedChangeInfoType
): Promise<void> {
  // Skip if syncing is in progress
  if (isSyncInProgress()) {
    logger.debug('Skipping bookmark changed event during sync');
    return;
  }

  // Check auth and settings
  const authenticated = await isAuthenticated();
  const settings = await getSettings();
  if (!authenticated || !settings.enabled) {
    return;
  }

  // Find the bookmark link
  const link = await findBookmarkLink(id);
  if (!link) {
    logger.debug('No link found for changed bookmark');
    return;
  }

  // Check if content actually changed
  const newTitle = changeInfo.title || link.title;
  const newUrl = changeInfo.url || link.url;
  const newHash = computeBookmarkHash(newUrl, newTitle);

  if (newHash === link.contentHash) {
    logger.debug('Content hash unchanged, skipping');
    return;
  }

  logger.info(`Bookmark changed: ${newTitle}`);

  const operation: SyncOperation = {
    id: generateId(),
    type: 'update',
    source: 'firefox',
    entityType: 'bookmark',
    data: {
      firefoxId: id,
      raindropId: link.raindropId,
      url: newUrl,
      title: newTitle,
      mappingId: link.mappingId,
    },
    timestamp: Date.now(),
    retries: 0,
    maxRetries: 3,
  };

  batchAddToQueue(operation);
}

async function handleBookmarkMoved(
  id: string,
  moveInfo: Bookmarks.OnMovedMoveInfoType
): Promise<void> {
  // Skip if syncing is in progress
  if (isSyncInProgress()) {
    logger.debug('Skipping bookmark moved event during sync');
    return;
  }

  // Check auth and settings
  const authenticated = await isAuthenticated();
  const settings = await getSettings();
  if (!authenticated || !settings.enabled) {
    return;
  }

  const oldParentMapping = await findMappingByFirefoxId(moveInfo.oldParentId);
  const newParentMapping = await findMappingByFirefoxId(moveInfo.parentId);

  // Find the bookmark link
  const link = await findBookmarkLink(id);

  if (!oldParentMapping && !newParentMapping) {
    // Neither folder is synced, ignore
    logger.debug('Neither old nor new parent is synced');
    return;
  }

  if (oldParentMapping && !newParentMapping) {
    // Moved OUT of synced folder - delete from Raindrop
    if (link) {
      logger.info(`Bookmark moved out of synced folder: ${link.title}`);

      const operation: SyncOperation = {
        id: generateId(),
        type: 'delete',
        source: 'firefox',
        entityType: 'bookmark',
        data: {
          firefoxId: id,
          raindropId: link.raindropId,
          mappingId: oldParentMapping.id,
        },
        timestamp: Date.now(),
        retries: 0,
        maxRetries: 3,
      };

      batchAddToQueue(operation);
    }
  } else if (!oldParentMapping && newParentMapping) {
    // Moved INTO synced folder - create in Raindrop
    try {
      const [bookmark] = await browser.bookmarks.get(id);

      if (bookmark.url) {
        logger.info(`Bookmark moved into synced folder: ${bookmark.title}`);

        const operation: SyncOperation = {
          id: generateId(),
          type: 'create',
          source: 'firefox',
          entityType: 'bookmark',
          data: {
            firefoxId: id,
            url: bookmark.url,
            title: bookmark.title,
            collectionId: newParentMapping.raindropCollectionId,
            mappingId: newParentMapping.id,
          },
          timestamp: Date.now(),
          retries: 0,
          maxRetries: 3,
        };

        batchAddToQueue(operation);
      }
    } catch (error) {
      logger.error('Failed to get moved bookmark details', error);
    }
  } else if (oldParentMapping && newParentMapping) {
    // Moved between synced folders - update collection
    if (link) {
      logger.info(`Bookmark moved between synced folders: ${link.title}`);

      const operation: SyncOperation = {
        id: generateId(),
        type: 'move',
        source: 'firefox',
        entityType: 'bookmark',
        data: {
          firefoxId: id,
          raindropId: link.raindropId,
          oldCollectionId: oldParentMapping.raindropCollectionId,
          newCollectionId: newParentMapping.raindropCollectionId,
          mappingId: newParentMapping.id,
        },
        timestamp: Date.now(),
        retries: 0,
        maxRetries: 3,
      };

      batchAddToQueue(operation);
    }
  }
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

  listenersRegistered = false;
  logger.info('Bookmark listeners unregistered');
}

