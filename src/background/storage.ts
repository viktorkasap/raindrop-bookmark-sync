// Storage Manager for the extension

import browser from 'webextension-polyfill';
import { Mutex } from 'async-mutex';
import {
  ApiToken,
  SyncSettings,
  FolderMapping,
  BookmarkLink,
  SyncStats,
  SyncErrorEntry,
  STORAGE_KEYS,
  DEFAULT_SYNC_SETTINGS,
  DEFAULT_SYNC_STATS,
} from '../types/storage';
import { logger } from '../utils/logger';

// ==================== Storage Lock ====================

/**
 * Serializes storage.local writes for atomicity. Thin wrapper over async-mutex;
 * runExclusive releases the lock on both resolve and reject, so a failing task
 * cannot wedge the queue.
 */
class StorageLock {
  private mutex = new Mutex();

  run<T>(task: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(task);
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

/**
 * Disconnect = blank slate. Wipes ALL extension-owned local storage — token,
 * mappings, bookmark links, settings, queue, stats, and the transient queue
 * lock — so a disconnect is a full teardown of the extension's state (task
 * 011). The user's real data is untouched: browser bookmark folders and
 * Raindrop collections live outside `storage.local` and are the user's
 * responsibility, consistent with the "remove mapping ≠ delete data" model.
 *
 * Callers must quiesce background writers first (stop the queue processor,
 * unregister listeners, clear alarms) — that is what actually prevents a key
 * being resurrected after the clear, since most mutators write storage.local
 * directly rather than through this lock. The storageLock.run wrapper only
 * orders this against the link/queue mutators that do use it.
 */
export async function resetLocalState(): Promise<void> {
  await storageLock.run(async () => {
    await browser.storage.local.clear();
    logger.info('Extension local state reset (disconnect)');
  });
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

/**
 * With no folder mappings there is nothing to sync, so auto-sync must not stay
 * on (task 012 — "no mapping, no sync"). Called after a mapping is removed:
 * when the last one is gone, force `enabled` off. Returns true only when it
 * actually flipped enabled from on to off, so the caller can tear down the
 * auto-sync services. No-op when a mapping still exists or sync is already off.
 */
export async function disableAutoSyncIfNoMappings(): Promise<boolean> {
  const mappings = await getFolderMappings();
  if (mappings.length > 0) return false;

  const settings = await getSettings();
  if (!settings.enabled) return false;

  await updateSettings({ enabled: false });
  logger.info('No folder mappings left — auto-sync disabled');
  return true;
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

export async function removeBookmarkLinksForMapping(
  mappingId: string
): Promise<void> {
  return storageLock.run(async () => {
    const links = await getBookmarkLinks();
    const filtered = links.filter((l) => l.mappingId !== mappingId);
    if (filtered.length !== links.length) {
      await _saveBookmarkLinks(filtered);
    }
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

// ==================== Sync Errors (inline, task 015) ====================

// The errors from the LAST reconcile pass, replaced wholesale on every pass
// (clean pass → []). The Options page renders each entry inline next to the
// mapping it happened under. Capped so a pathological pass can't bloat storage.
const MAX_SYNC_ERRORS = 50;

export async function getSyncErrors(): Promise<SyncErrorEntry[]> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.SYNC_ERRORS);
    return (result[STORAGE_KEYS.SYNC_ERRORS] as SyncErrorEntry[]) || [];
  } catch (error) {
    logger.error('Failed to get sync errors', error);
    return [];
  }
}

export async function setSyncErrors(errors: SyncErrorEntry[]): Promise<void> {
  try {
    await browser.storage.local.set({
      [STORAGE_KEYS.SYNC_ERRORS]: errors.slice(0, MAX_SYNC_ERRORS),
    });
  } catch (error) {
    logger.error('Failed to set sync errors', error);
  }
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
