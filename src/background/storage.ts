// Storage Manager for the extension

import browser from 'webextension-polyfill';
import {
  ApiToken,
  SyncSettings,
  FolderMapping,
  BookmarkLink,
  SyncQueue,
  SyncOperation,
  SyncStats,
  SyncError,
  STORAGE_KEYS,
  DEFAULT_SYNC_SETTINGS,
  DEFAULT_SYNC_STATS,
  DEFAULT_SYNC_QUEUE,
} from '../types/storage';
import { logger } from '../utils/logger';

// ==================== Storage Lock (Task Queue) ====================

/**
 * Simple task queue to ensure atomic storage operations
 */
class StorageLock {
  private queue: Promise<any> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
}

const storageLock = new StorageLock();

// ==================== API Token ====================

export async function saveApiToken(token: string): Promise<void> {
  try {
    const data: ApiToken = { testToken: token };
    await browser.storage.local.set({
      [STORAGE_KEYS.API_TOKEN]: data,
    });
    logger.debug('API token saved successfully');
  } catch (error) {
    logger.error('Failed to save API token', error);
    throw error;
  }
}

export async function getApiToken(): Promise<string | null> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.API_TOKEN);
    const data = result[STORAGE_KEYS.API_TOKEN] as ApiToken | undefined;
    return data?.testToken || null;
  } catch (error) {
    logger.error('Failed to get API token', error);
    return null;
  }
}

export async function clearApiToken(): Promise<void> {
  try {
    await browser.storage.local.remove(STORAGE_KEYS.API_TOKEN);
    logger.debug('API token cleared successfully');
  } catch (error) {
    logger.error('Failed to clear API token', error);
    throw error;
  }
}

export async function isAuthenticated(): Promise<boolean> {
  const token = await getApiToken();
  return !!token;
}

// ==================== Sync Settings ====================

export async function saveSettings(settings: SyncSettings): Promise<void> {
  try {
    await browser.storage.local.set({
      [STORAGE_KEYS.SYNC_SETTINGS]: settings,
    });
    logger.debug('Settings saved successfully');
  } catch (error) {
    logger.error('Failed to save settings', error);
    throw error;
  }
}

export async function getSettings(): Promise<SyncSettings> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.SYNC_SETTINGS);
    return (result[STORAGE_KEYS.SYNC_SETTINGS] as SyncSettings) || DEFAULT_SYNC_SETTINGS;
  } catch (error) {
    logger.error('Failed to get settings', error);
    return { ...DEFAULT_SYNC_SETTINGS };
  }
}

export async function updateSettings(
  updates: Partial<SyncSettings>
): Promise<SyncSettings> {
  const current = await getSettings();
  const updated = { ...current, ...updates };
  await saveSettings(updated);
  return updated;
}

// ==================== Folder Mappings ====================

export async function saveFolderMappings(
  mappings: FolderMapping[]
): Promise<void> {
  try {
    await browser.storage.local.set({
      [STORAGE_KEYS.FOLDER_MAPPINGS]: mappings,
    });
    logger.debug('Folder mappings saved', { count: mappings.length });
  } catch (error) {
    logger.error('Failed to save folder mappings', error);
    throw error;
  }
}

export async function getFolderMappings(): Promise<FolderMapping[]> {
  try {
    const result = await browser.storage.local.get(
      STORAGE_KEYS.FOLDER_MAPPINGS
    );
    return (result[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[]) || [];
  } catch (error) {
    logger.error('Failed to get folder mappings', error);
    return [];
  }
}

export async function addFolderMapping(
  mapping: FolderMapping
): Promise<FolderMapping[]> {
  const mappings = await getFolderMappings();

  // Check for duplicates
  const exists = mappings.find(
    (m) =>
      m.firefoxFolderId === mapping.firefoxFolderId ||
      m.raindropCollectionId === mapping.raindropCollectionId
  );

  if (exists) {
    throw new Error('Mapping already exists for this folder or collection');
  }

  mappings.push(mapping);
  await saveFolderMappings(mappings);
  return mappings;
}

export async function removeFolderMapping(mappingId: string): Promise<void> {
  const mappings = await getFolderMappings();
  
  // Find mapping to be removed and its children (recursively if needed, though depth 1 is common)
  const idsToRemove = new Set<string>([mappingId]);
  
  // One pass for children is enough for depth 1, but let's be more robust
  let added;
  do {
    added = false;
    for (const m of mappings) {
      if (m.parentMappingId && idsToRemove.has(m.parentMappingId) && !idsToRemove.has(m.id)) {
        idsToRemove.add(m.id);
        added = true;
      }
    }
  } while (added);

  const filtered = mappings.filter((m) => !idsToRemove.has(m.id));
  await saveFolderMappings(filtered);

  // Also remove associated bookmark links for ALL removed mappings
  const links = await getBookmarkLinks();
  const filteredLinks = links.filter((l) => !idsToRemove.has(l.mappingId));
  await saveBookmarkLinks(filteredLinks);
  
  logger.info('Removed folder mapping(s) and associated links', { 
    removedMappings: idsToRemove.size,
    removedLinks: links.length - filteredLinks.length 
  });
}

export async function updateFolderMapping(
  mappingId: string,
  updates: Partial<FolderMapping>
): Promise<FolderMapping | null> {
  const mappings = await getFolderMappings();
  const index = mappings.findIndex((m) => m.id === mappingId);

  if (index === -1) return null;

  mappings[index] = { ...mappings[index], ...updates };
  await saveFolderMappings(mappings);
  return mappings[index];
}

export async function findMappingByFirefoxId(
  firefoxFolderId: string
): Promise<FolderMapping | null> {
  const mappings = await getFolderMappings();
  return mappings.find((m) => m.firefoxFolderId === firefoxFolderId) || null;
}

export async function findMappingByRaindropId(
  raindropCollectionId: number
): Promise<FolderMapping | null> {
  const mappings = await getFolderMappings();
  return (
    mappings.find((m) => m.raindropCollectionId === raindropCollectionId) ||
    null
  );
}

// ==================== Bookmark Links ====================

// Internal save — no lock, used by functions that already hold storageLock
async function _saveBookmarkLinks(links: BookmarkLink[]): Promise<void> {
  try {
    await browser.storage.local.set({
      [STORAGE_KEYS.BOOKMARK_LINKS]: links,
    });
    logger.debug('Bookmark links saved', { count: links.length });
  } catch (error) {
    logger.error('Failed to save bookmark links', error);
    throw error;
  }
}

// External save — acquires lock, safe for callers outside storageLock
export async function saveBookmarkLinks(links: BookmarkLink[]): Promise<void> {
  return storageLock.run(() => _saveBookmarkLinks(links));
}

export async function getBookmarkLinks(): Promise<BookmarkLink[]> {
  try {
    const result = await browser.storage.local.get(
      STORAGE_KEYS.BOOKMARK_LINKS
    );
    return (result[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[]) || [];
  } catch (error) {
    logger.error('Failed to get bookmark links', error);
    return [];
  }
}

export async function addBookmarkLink(link: BookmarkLink): Promise<void> {
  return storageLock.run(async () => {
    const links = await getBookmarkLinks();

    // Check if link already exists to avoid duplicates
    // Each Firefox ID and each Raindrop ID should have at most one link
    const exists = links.some(
      (l) => l.firefoxId === link.firefoxId || l.raindropId === link.raindropId
    );

    if (!exists) {
      links.push(link);
      await _saveBookmarkLinks(links);
    } else {
      logger.debug('Bookmark link already exists for this ID, skipping', {
        firefoxId: link.firefoxId,
        raindropId: link.raindropId,
      });
    }
  });
}

export async function updateBookmarkLink(
  linkId: string,
  updates: Partial<BookmarkLink>
): Promise<BookmarkLink | null> {
  return storageLock.run(async () => {
    const links = await getBookmarkLinks();
    const index = links.findIndex((l) => l.id === linkId);

    if (index === -1) return null;

    links[index] = { ...links[index], ...updates };
    await _saveBookmarkLinks(links);
    return links[index];
  });
}

export async function removeBookmarkLink(linkId: string): Promise<void> {
  return storageLock.run(async () => {
    const links = await getBookmarkLinks();
    const filtered = links.filter((l) => l.id !== linkId);
    await _saveBookmarkLinks(filtered);
  });
}

export async function findBookmarkLink(
  firefoxId?: string,
  raindropId?: number
): Promise<BookmarkLink | null> {
  const links = await getBookmarkLinks();

  if (firefoxId) {
    const byFirefox = links.find((l) => l.firefoxId === firefoxId);
    if (byFirefox) return byFirefox;
  }

  if (raindropId) {
    const byRaindrop = links.find((l) => l.raindropId === raindropId);
    if (byRaindrop) return byRaindrop;
  }

  return null;
}

export async function findBookmarkLinkByUrl(
  url: string
): Promise<BookmarkLink | null> {
  const links = await getBookmarkLinks();
  return links.find((l) => l.url === url) || null;
}

export async function getBookmarkLinksForMapping(
  mappingId: string
): Promise<BookmarkLink[]> {
  const links = await getBookmarkLinks();
  return links.filter((l) => l.mappingId === mappingId);
}

// ==================== Sync Queue ====================

export async function getQueue(): Promise<SyncQueue> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.SYNC_QUEUE);
    return (result[STORAGE_KEYS.SYNC_QUEUE] as SyncQueue) || DEFAULT_SYNC_QUEUE;
  } catch (error) {
    logger.error('Failed to get sync queue', error);
    return { ...DEFAULT_SYNC_QUEUE };
  }
}

// Internal save — no lock, used by functions that already hold storageLock
async function _saveQueue(queue: SyncQueue): Promise<void> {
  try {
    await browser.storage.local.set({
      [STORAGE_KEYS.SYNC_QUEUE]: queue,
    });
  } catch (error) {
    logger.error('Failed to save sync queue', error);
    throw error;
  }
}

// External save — acquires lock, safe for callers outside storageLock
export async function saveQueue(queue: SyncQueue): Promise<void> {
  return storageLock.run(() => _saveQueue(queue));
}

export async function addToQueue(operation: SyncOperation): Promise<void> {
  return storageLock.run(async () => {
    const queue = await getQueue();

    // Check for duplicate operations
    const exists = queue.pending.find(
      (op) =>
        op.type === operation.type &&
        op.source === operation.source &&
        op.data.firefoxId === operation.data.firefoxId &&
        op.data.raindropId === operation.data.raindropId
    );

    if (!exists) {
      queue.pending.push(operation);
      await _saveQueue(queue);
      logger.debug('Operation added to queue', { operation });
    }
  });
}

export async function removeFromQueue(operationId: string): Promise<void> {
  return storageLock.run(async () => {
    const queue = await getQueue();
    queue.pending = queue.pending.filter((op) => op.id !== operationId);
    queue.failed = queue.failed.filter((op) => op.id !== operationId);
    await _saveQueue(queue);
  });
}

const MAX_FAILED_QUEUE = 100;

export async function moveToFailed(
  operationId: string,
  errorMessage: string
): Promise<void> {
  return storageLock.run(async () => {
    const queue = await getQueue();
    const operation = queue.pending.find((op) => op.id === operationId);

    if (operation) {
      operation.retries += 1;
      operation.lastError = errorMessage;

      if (operation.retries >= operation.maxRetries) {
        queue.pending = queue.pending.filter((op) => op.id !== operationId);
        queue.failed.push(operation);

        // Trim oldest failed operations if over limit
        if (queue.failed.length > MAX_FAILED_QUEUE) {
          queue.failed = queue.failed.slice(-MAX_FAILED_QUEUE);
        }

        logger.warn('Operation moved to failed queue', { operation });
      }

      await _saveQueue(queue);
    }
  });
}

export async function clearQueue(): Promise<void> {
  await saveQueue({ pending: [], failed: [] });
}

export async function retryFailed(): Promise<void> {
  const queue = await getQueue();

  // Move failed operations back to pending with reset retries
  for (const op of queue.failed) {
    op.retries = 0;
    op.lastError = undefined;
    queue.pending.push(op);
  }

  queue.failed = [];
  await saveQueue(queue);
}

// ==================== Sync Stats ====================

export async function getSyncStats(): Promise<SyncStats> {
  try {
    const result = await browser.storage.local.get([
      STORAGE_KEYS.SYNC_STATS,
      STORAGE_KEYS.BOOKMARK_LINKS,
    ]);
    const stats = (result[STORAGE_KEYS.SYNC_STATS] as SyncStats) || {
      ...DEFAULT_SYNC_STATS,
    };
    const links = (result[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[]) || [];

    // Always return actual links count
    return {
      ...stats,
      totalSynced: links.length,
    };
  } catch (error) {
    logger.error('Failed to get sync stats', error);
    return { ...DEFAULT_SYNC_STATS };
  }
}

export async function updateSyncStats(
  updates: Partial<SyncStats>
): Promise<SyncStats> {
  const current = await getSyncStats();
  const updated = { ...current, ...updates };

  try {
    await browser.storage.local.set({
      [STORAGE_KEYS.SYNC_STATS]: updated,
    });
    return updated;
  } catch (error) {
    logger.error('Failed to update sync stats', error);
    throw error;
  }
}

export async function addSyncError(error: SyncError): Promise<void> {
  const stats = await getSyncStats();

  // Keep only last 50 errors
  stats.errors.unshift(error);
  if (stats.errors.length > 50) {
    stats.errors = stats.errors.slice(0, 50);
  }

  await updateSyncStats(stats);
}

export async function clearSyncErrors(): Promise<void> {
  await updateSyncStats({ errors: [] });
}

// ==================== Utility Functions ====================

export async function clearAllData(): Promise<void> {
  try {
    await browser.storage.local.clear();
    logger.info('All storage data cleared');
  } catch (error) {
    logger.error('Failed to clear all data', error);
    throw error;
  }
}

export async function exportData(): Promise<Record<string, unknown>> {
  try {
    const data = await browser.storage.local.get(null);
    // Remove sensitive data
    delete data[STORAGE_KEYS.API_TOKEN];
    return data;
  } catch (error) {
    logger.error('Failed to export data', error);
    throw error;
  }
}

export async function importData(
  data: Record<string, unknown>
): Promise<void> {
  try {
    await browser.storage.local.set(data);
    logger.info('Data imported successfully');
  } catch (error) {
    logger.error('Failed to import data', error);
    throw error;
  }
}
