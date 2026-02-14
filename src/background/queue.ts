// Sync Queue Processor

import {
  SyncOperation,
  SyncOperationData,
  BookmarkLink,
} from '../types/storage';
import {
  getQueue,
  removeFromQueue,
  moveToFailed,
  addBookmarkLink,
  updateBookmarkLink,
  removeBookmarkLink,
  findBookmarkLink,
  findMappingByFirefoxId,
  updateSyncStats,
  addSyncError,
} from './storage';
import {
  createRaindrop,
  updateRaindrop,
  deleteRaindrop,
  getRaindrop,
} from './raindropApi';
import { setSyncing } from './bookmarkListeners';
import browser from 'webextension-polyfill';
import { logger } from '../utils/logger';
import { generateId, computeBookmarkHash } from '../utils/hash';

// Processing lock timeout — if a lock is older than this, consider it stale
// (e.g. Service Worker was killed mid-processing in Chrome MV3)
const PROCESSING_LOCK_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const PROCESSING_LOCK_KEY = 'queue_processing_lock';

class SyncQueueProcessor {
  async start(): Promise<void> {
    // Schedule an alarm as the primary driver for queue processing.
    // In MV3 this is essential to wake up the Service Worker.
    // Only create if it doesn't already exist — avoids resetting the timer
    // on every SW restart in Chrome MV3.
    try {
      const existing = await browser.alarms.get('process-queue');
      if (!existing) {
        await browser.alarms.create('process-queue', { periodInMinutes: 1 });
        logger.debug('Queue processing alarm scheduled (every 1 minute)');
      }
    } catch (error) {
      logger.error('Failed to schedule queue alarm', error);
    }

    // Initial processing on start
    this.processQueue();

    logger.info('Queue processor initialized');
  }

  async stop(): Promise<void> {
    try {
      await browser.alarms.clear('process-queue');
      await this.releaseLock();
    } catch (error) {
      // Ignore
    }

    logger.info('Queue processor stopped');
  }

  private async acquireLock(): Promise<boolean> {
    const result = await browser.storage.local.get(PROCESSING_LOCK_KEY);
    const lock = result[PROCESSING_LOCK_KEY] as { timestamp: number } | undefined;

    if (lock && Date.now() - lock.timestamp < PROCESSING_LOCK_TIMEOUT) {
      return false; // lock is held and not stale
    }

    await browser.storage.local.set({
      [PROCESSING_LOCK_KEY]: { timestamp: Date.now() },
    });
    return true;
  }

  private async releaseLock(): Promise<void> {
    await browser.storage.local.remove(PROCESSING_LOCK_KEY);
  }

  async processQueue(): Promise<void> {
    const acquired = await this.acquireLock();
    if (!acquired) {
      logger.debug('Queue processing already in progress');
      return;
    }

    setSyncing(true);

    try {
      const queue = await getQueue();

      if (queue.pending.length === 0) {
        return;
      }

      logger.debug(`Processing ${queue.pending.length} pending operations`);

      for (let i = 0; i < queue.pending.length; i++) {
        const operation = queue.pending[i];
        try {
          await this.processOperation(operation);
          await removeFromQueue(operation.id);

          await updateSyncStats({
            pendingOperations: queue.pending.length - (i + 1),
            lastSyncTime: Date.now(),
            lastSyncStatus: 'success',
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';

          logger.error(
            `Failed to process operation ${operation.id}`,
            error
          );

          await moveToFailed(operation.id, errorMessage);

          await addSyncError({
            timestamp: Date.now(),
            operation: `${operation.type} ${operation.entityType}`,
            message: errorMessage,
            details: JSON.stringify(operation.data),
          });
        }
      }
    } catch (error) {
      logger.error('Queue processing failed', error);
    } finally {
      await this.releaseLock();
      setSyncing(false);
    }
  }

  private async processOperation(operation: SyncOperation): Promise<void> {
    logger.debug(`Processing operation: ${operation.type}`, operation);

    switch (operation.source) {
      case 'firefox':
        await this.processFirefoxOperation(operation);
        break;
      case 'raindrop':
        await this.processRaindropOperation(operation);
        break;
    }
  }

  private async processFirefoxOperation(
    operation: SyncOperation
  ): Promise<void> {
    const { type, data } = operation;

    switch (type) {
      case 'create':
        await this.pushCreateToRaindrop(data);
        break;
      case 'update':
        await this.pushUpdateToRaindrop(data);
        break;
      case 'delete':
        await this.pushDeleteToRaindrop(data);
        break;
      case 'move':
        await this.pushMoveToRaindrop(data);
        break;
    }
  }

  private async processRaindropOperation(
    operation: SyncOperation
  ): Promise<void> {
    const { type, data } = operation;

    switch (type) {
      case 'create':
        await this.pullCreateFromRaindrop(data);
        break;
      case 'update':
        await this.pullUpdateFromRaindrop(data);
        break;
      case 'delete':
        await this.pullDeleteFromRaindrop(data);
        break;
    }
  }

  // ==================== Push to Raindrop ====================

  private async pushCreateToRaindrop(data: SyncOperationData): Promise<void> {
    if (!data.url || !data.title || !data.collectionId || !data.firefoxId) {
      throw new Error('Missing required data for create operation');
    }

    // Check if link already exists to avoid duplicates
    const existingLink = await findBookmarkLink(data.firefoxId);
    if (existingLink) {
      logger.info(
        `Link already exists for Firefox bookmark ${data.firefoxId}, skipping queue create`
      );
      return;
    }

    const raindrop = await createRaindrop({
      link: data.url,
      title: data.title,
      collection: { $id: data.collectionId },
    });

    // Create bookmark link
    const link: BookmarkLink = {
      id: generateId(),
      firefoxId: data.firefoxId,
      raindropId: raindrop._id,
      url: data.url,
      title: data.title,
      lastModified: Date.now(),
      contentHash: computeBookmarkHash(data.url, data.title),
      syncStatus: 'synced',
      mappingId: data.mappingId || '',
    };

    await addBookmarkLink(link);

    logger.info(`Created raindrop for bookmark: ${data.title}`);
  }

  private async pushUpdateToRaindrop(data: SyncOperationData): Promise<void> {
    if (!data.raindropId) {
      throw new Error('Missing raindrop ID for update operation');
    }

    const updates: Record<string, unknown> = {};

    if (data.url) updates.link = data.url;
    if (data.title) updates.title = data.title;

    await updateRaindrop(data.raindropId, updates);

    // Update bookmark link
    const link = await findBookmarkLink(data.firefoxId, data.raindropId);
    if (link) {
      await updateBookmarkLink(link.id, {
        url: data.url || link.url,
        title: data.title || link.title,
        lastModified: Date.now(),
        contentHash: computeBookmarkHash(
          data.url || link.url,
          data.title || link.title
        ),
        syncStatus: 'synced',
      });
    }

    logger.info(`Updated raindrop: ${data.raindropId}`);
  }

  private async pushDeleteToRaindrop(data: SyncOperationData): Promise<void> {
    if (!data.raindropId) {
      throw new Error('Missing raindrop ID for delete operation');
    }

    await deleteRaindrop(data.raindropId);

    // Remove bookmark link
    const link = await findBookmarkLink(data.firefoxId, data.raindropId);
    if (link) {
      await removeBookmarkLink(link.id);
    }

    logger.info(`Deleted raindrop: ${data.raindropId}`);
  }

  private async pushMoveToRaindrop(data: SyncOperationData): Promise<void> {
    if (!data.raindropId || !data.newCollectionId) {
      throw new Error('Missing data for move operation');
    }

    await updateRaindrop(data.raindropId, {
      collection: { $id: data.newCollectionId },
    });

    // Update bookmark link mapping
    const link = await findBookmarkLink(data.firefoxId, data.raindropId);
    if (link && data.mappingId) {
      await updateBookmarkLink(link.id, {
        mappingId: data.mappingId,
        lastModified: Date.now(),
        syncStatus: 'synced',
      });
    }

    logger.info(
      `Moved raindrop ${data.raindropId} to collection ${data.newCollectionId}`
    );
  }

  // ==================== Pull from Raindrop ====================

  private async pullCreateFromRaindrop(data: SyncOperationData): Promise<void> {
    if (!data.raindropId || !data.parentFolderId) {
      throw new Error('Missing data for create from Raindrop');
    }

    // Check if link already exists to avoid duplicates
    const existingLink = await findBookmarkLink(undefined, data.raindropId);
    if (existingLink) {
      logger.info(
        `Link already exists for Raindrop ${data.raindropId}, skipping queue pull create`
      );
      return;
    }

    // Get raindrop details
    const raindrop = await getRaindrop(data.raindropId);

    // Create Firefox bookmark
    const bookmark = await browser.bookmarks.create({
      parentId: data.parentFolderId,
      title: raindrop.title,
      url: raindrop.link,
    });

    // Create bookmark link
    const mapping = await findMappingByFirefoxId(data.parentFolderId);

    const link: BookmarkLink = {
      id: generateId(),
      firefoxId: bookmark.id,
      raindropId: raindrop._id,
      url: raindrop.link,
      title: raindrop.title,
      lastModified: Date.now(),
      contentHash: computeBookmarkHash(raindrop.link, raindrop.title),
      syncStatus: 'synced',
      mappingId: mapping?.id || '',
    };

    await addBookmarkLink(link);

    logger.info(`Created Firefox bookmark from Raindrop: ${raindrop.title}`);
  }

  private async pullUpdateFromRaindrop(data: SyncOperationData): Promise<void> {
    if (!data.firefoxId || !data.raindropId) {
      throw new Error('Missing data for update from Raindrop');
    }

    // Get raindrop details
    const raindrop = await getRaindrop(data.raindropId);

    // Update Firefox bookmark
    await browser.bookmarks.update(data.firefoxId, {
      title: raindrop.title,
      url: raindrop.link,
    });

    // Update bookmark link
    const link = await findBookmarkLink(data.firefoxId, data.raindropId);
    if (link) {
      await updateBookmarkLink(link.id, {
        url: raindrop.link,
        title: raindrop.title,
        lastModified: Date.now(),
        contentHash: computeBookmarkHash(raindrop.link, raindrop.title),
        syncStatus: 'synced',
      });
    }

    logger.info(`Updated Firefox bookmark from Raindrop: ${raindrop.title}`);
  }

  private async pullDeleteFromRaindrop(data: SyncOperationData): Promise<void> {
    if (!data.firefoxId) {
      throw new Error('Missing Firefox ID for delete from Raindrop');
    }

    try {
      await browser.bookmarks.remove(data.firefoxId);
    } catch (error) {
      // Bookmark may already be deleted
      logger.warn(`Bookmark ${data.firefoxId} may already be deleted`, error);
    }

    // Remove bookmark link
    const link = await findBookmarkLink(data.firefoxId, data.raindropId);
    if (link) {
      await removeBookmarkLink(link.id);
    }

    logger.info(`Deleted Firefox bookmark: ${data.firefoxId}`);
  }

  // ==================== Force Process ====================

  async forceProcess(): Promise<void> {
    // Release any existing lock and process immediately
    await this.releaseLock();
    await this.processQueue();
  }
}

export const queueProcessor = new SyncQueueProcessor();
export default queueProcessor;
