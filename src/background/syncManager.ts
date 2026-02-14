// Sync Manager - Core synchronization logic

import { FolderMapping, BookmarkLink, SyncOperation } from '../types/storage';
import { SyncStatus } from '../types/messages';
import { Raindrop, Collection, CreateRaindropData } from '../types/raindrop';
import {
  getSettings,
  updateSettings,
  getFolderMappings,
  addFolderMapping,
  updateFolderMapping,
  getBookmarkLinks,
  saveBookmarkLinks,
  addBookmarkLink,
  updateBookmarkLink,
  removeBookmarkLink,
  updateSyncStats,
  getSyncStats,
  getBookmarkLinksForMapping,
  isAuthenticated as checkIsAuthenticated,
} from './storage';
import {
  getAllCollections,
  getAllRaindropsInCollection,
  createRaindrops,
  createCollection,
  getCurrentUser,
} from './raindropApi';
import { setSyncing } from './bookmarkListeners';
import browser, { Bookmarks, Alarms } from 'webextension-polyfill';
import { logger } from '../utils/logger';
import {
  generateId,
  computeBookmarkHash,
  computeRaindropHash,
  normalizeUrl,
  urlsMatch,
  isValidSyncUrl,
} from '../utils/hash';

// ==================== Initial Sync ====================

export interface InitialSyncResult {
  matched: number;
  createdInRaindrop: number;
  createdInFirefox: number;
  errors: string[];
}

export async function performInitialSync(
  mapping: FolderMapping
): Promise<InitialSyncResult> {
  const result: InitialSyncResult = {
    matched: 0,
    createdInRaindrop: 0,
    createdInFirefox: 0,
    errors: [],
  };

  setSyncing(true);

  try {
    logger.info(`Starting initial sync for folder: ${mapping.folderName}`);

    // Verify folder still exists
    try {
      await browser.bookmarks.get(mapping.firefoxFolderId);
    } catch (error) {
      logger.error(`Folder ${mapping.folderName} (${mapping.firefoxFolderId}) no longer exists`);
      result.errors.push(`Folder "${mapping.folderName}" not found`);
      return result;
    }

    // Get all Firefox bookmarks in the folder
    const firefoxBookmarks = await browser.bookmarks.getChildren(
      mapping.firefoxFolderId
    );
    const bookmarks = firefoxBookmarks.filter(
      (b) => (b.type === 'bookmark' || (!b.type && b.url)) && b.url
    );

    // Get all raindrops from the collection
    const raindrops = await getAllRaindropsInCollection(
      mapping.raindropCollectionId
    );

    // Match bookmarks by URL
    const matched: { bookmark: Bookmarks.BookmarkTreeNode; raindrop: Raindrop }[] = [];
    const onlyInFirefox: Bookmarks.BookmarkTreeNode[] = [];
    const onlyInRaindrop: Raindrop[] = [];

    // Create URL map for faster lookup
    const raindropByUrl = new Map<string, Raindrop>();
    for (const raindrop of raindrops) {
      raindropByUrl.set(normalizeUrl(raindrop.link), raindrop);
    }

    // Match Firefox bookmarks to Raindrops
    for (const bookmark of bookmarks) {
      if (!bookmark.url) continue;

      // Skip internal browser URLs
      if (!isValidSyncUrl(bookmark.url)) continue;

      const normalizedUrl = normalizeUrl(bookmark.url);
      const matchingRaindrop = raindropByUrl.get(normalizedUrl);

      if (matchingRaindrop) {
        matched.push({ bookmark, raindrop: matchingRaindrop });
        raindropByUrl.delete(normalizedUrl); // Remove from map to track unmatched
      } else {
        onlyInFirefox.push(bookmark);
      }
    }

    // Remaining raindrops are only in Raindrop
    onlyInRaindrop.push(...raindropByUrl.values());

    // Create bookmark links for matched items
    for (const { bookmark, raindrop } of matched) {
      const link: BookmarkLink = {
        id: generateId(),
        firefoxId: bookmark.id,
        raindropId: raindrop._id,
        url: bookmark.url!,
        title: bookmark.title,
        lastModified: Date.now(),
        contentHash: computeBookmarkHash(bookmark.url!, bookmark.title),
        syncStatus: 'synced',
        mappingId: mapping.id,
      };

      await addBookmarkLink(link);
      result.matched++;
    }

    // Create raindrops for Firefox-only bookmarks
    if (onlyInFirefox.length > 0) {
      try {
        logger.info(`Bulk creating ${onlyInFirefox.length} raindrops for initial sync`);
        const raindropsToCreate = onlyInFirefox
          .filter(b => b.url)
          .map(b => ({
            link: b.url!,
            title: b.title,
            collection: { $id: mapping.raindropCollectionId },
          }));
        
        const createdRaindrops = await createRaindrops(raindropsToCreate);
        
        // Match created raindrops back to Firefox bookmarks by URL.
        // Use splice to avoid matching the same bookmark twice when URLs are identical.
        const remainingBookmarks = [...onlyInFirefox];
        for (const raindrop of createdRaindrops) {
          const idx = remainingBookmarks.findIndex(b => b.url && urlsMatch(b.url, raindrop.link));
          if (idx === -1) continue;

          const originalBookmark = remainingBookmarks[idx];
          remainingBookmarks.splice(idx, 1);

          const link: BookmarkLink = {
            id: generateId(),
            firefoxId: originalBookmark.id,
            raindropId: raindrop._id,
            url: raindrop.link,
            title: raindrop.title,
            lastModified: Date.now(),
            contentHash: computeBookmarkHash(raindrop.link, raindrop.title),
            syncStatus: 'synced',
            mappingId: mapping.id,
          };

          await addBookmarkLink(link);
          result.createdInRaindrop++;
        }
      } catch (error) {
        const errorMsg = `Initial bulk create in Raindrop failed: ${error}`;
        result.errors.push(errorMsg);
        logger.error(errorMsg);
      }
    }

    // Create Firefox bookmarks for Raindrop-only items
    for (const raindrop of onlyInRaindrop) {
      try {
        const bookmark = await browser.bookmarks.create({
          parentId: mapping.firefoxFolderId,
          title: raindrop.title,
          url: raindrop.link,
        });

        const link: BookmarkLink = {
          id: generateId(),
          firefoxId: bookmark.id,
          raindropId: raindrop._id,
          url: raindrop.link,
          title: raindrop.title,
          lastModified: Date.now(),
          contentHash: computeRaindropHash(raindrop.link, raindrop.title),
          syncStatus: 'synced',
          mappingId: mapping.id,
        };

        await addBookmarkLink(link);
        result.createdInFirefox++;
      } catch (error) {
        const errorMsg = `Failed to create bookmark for "${raindrop.title}": ${error}`;
        result.errors.push(errorMsg);
        logger.error(errorMsg);
      }
    }

    // Update mapping with last sync time
    await updateFolderMapping(mapping.id, { lastSync: Date.now() });

    logger.info('Initial sync completed', result);

    return result;
  } finally {
    setSyncing(false);
  }
}

// ==================== Pull Sync (Raindrop → Firefox) ====================

export interface PullSyncResult {
  created: number;
  updated: number;
  deleted: number;
  errors: string[];
}

export async function pullFromRaindrop(): Promise<PullSyncResult> {
  const result: PullSyncResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    errors: [],
  };

  const settings = await getSettings();
  if (!settings.enabled) {
    logger.debug('Sync is disabled');
    return result;
  }

  // Check if sync is already in progress
  const { isSyncInProgress } = await import('./bookmarkListeners');
  if (isSyncInProgress()) {
    logger.debug('Sync already in progress, skipping pull');
    return result;
  }

  const mappings = await getFolderMappings();
  if (mappings.length === 0) {
    logger.debug('No folder mappings configured');
    return result;
  }

  setSyncing(true);

  try {
    logger.info('Starting pull sync from Raindrop');

    for (const mapping of mappings) {
      try {
        const mappingResult = await pullSyncForMapping(mapping);
        result.created += mappingResult.created;
        result.updated += mappingResult.updated;
        result.deleted += mappingResult.deleted;
        result.errors.push(...mappingResult.errors);
      } catch (error) {
        const errorMsg = `Failed to sync mapping ${mapping.folderName}: ${error}`;
        result.errors.push(errorMsg);
        logger.error(errorMsg);
      }
    }

    // Update stats
    await updateSyncStats({
      lastSyncTime: Date.now(),
      lastSyncStatus: result.errors.length === 0 ? 'success' : 'partial',
    });

    logger.info('Pull sync completed', result);

    return result;
  } finally {
    setSyncing(false);
  }
}

async function pullSyncForMapping(
  mapping: FolderMapping
): Promise<PullSyncResult> {
  const result: PullSyncResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    errors: [],
  };

  // Get all raindrops from collection
  const raindrops = await getAllRaindropsInCollection(
    mapping.raindropCollectionId
  );

  // Get local bookmark links for this mapping only
  const localLinks = await getBookmarkLinksForMapping(mapping.id);

  // Get ALL local bookmark links for global deduplication
  const allLinks = await getBookmarkLinks();

  // Global map — for checking if raindrop is already linked in ANY mapping
  const globalLinksByRaindropId = new Map<number, BookmarkLink>();
  for (const link of allLinks) {
    globalLinksByRaindropId.set(link.raindropId, link);
  }

  // Local map — only links belonging to THIS mapping (safe to update)
  const localLinksByRaindropId = new Map<number, BookmarkLink>();
  for (const link of localLinks) {
    localLinksByRaindropId.set(link.raindropId, link);
  }

  const raindropById = new Map<number, Raindrop>();
  for (const raindrop of raindrops) {
    raindropById.set(raindrop._id, raindrop);
  }

  // URL set — for detecting duplicate raindrops (same URL, different ID).
  // Prevents exponential duplication when a raindrop is duplicated in Raindrop.io.
  const linkedUrls = new Set<string>();
  for (const link of allLinks) {
    if (link.url) {
      linkedUrls.add(normalizeUrl(link.url));
    }
  }

  // Process raindrops
  for (const raindrop of raindrops) {
    const globalLink = globalLinksByRaindropId.get(raindrop._id);
    const localLink = localLinksByRaindropId.get(raindrop._id);

    if (!globalLink) {
      // Check if this URL is already linked via another raindrop ID (duplicate raindrop).
      // This stops the feedback loop: pull creates bookmark → event queues create →
      // queue creates duplicate raindrop with new ID → next pull sees it as "new" → repeat.
      const normalizedUrl = normalizeUrl(raindrop.link);
      if (linkedUrls.has(normalizedUrl)) {
        logger.debug(`Raindrop ${raindrop._id} URL already linked, skipping duplicate`);
        continue;
      }

      // Truly new raindrop — not linked in any mapping. Create Firefox bookmark.
      try {
        const bookmark = await browser.bookmarks.create({
          parentId: mapping.firefoxFolderId,
          title: raindrop.title,
          url: raindrop.link,
        });

        const link: BookmarkLink = {
          id: generateId(),
          firefoxId: bookmark.id,
          raindropId: raindrop._id,
          url: raindrop.link,
          title: raindrop.title,
          lastModified: Date.now(),
          contentHash: computeRaindropHash(raindrop.link, raindrop.title),
          syncStatus: 'synced',
          mappingId: mapping.id,
        };

        await addBookmarkLink(link);
        linkedUrls.add(normalizedUrl);
        result.created++;
      } catch (error) {
        result.errors.push(`Failed to create bookmark: ${error}`);
      }
    } else if (localLink) {
      // Link belongs to THIS mapping — safe to check for updates
      const currentHash = computeRaindropHash(raindrop.link, raindrop.title);

      if (currentHash !== localLink.contentHash) {
        try {
          await browser.bookmarks.update(localLink.firefoxId, {
            title: raindrop.title,
            url: raindrop.link,
          });

          await updateBookmarkLink(localLink.id, {
            url: raindrop.link,
            title: raindrop.title,
            lastModified: Date.now(),
            contentHash: currentHash,
            syncStatus: 'synced',
          });

          result.updated++;
        } catch (error) {
          result.errors.push(`Failed to update bookmark: ${error}`);
        }
      }
    }
    // If globalLink exists but localLink doesn't — raindrop is managed by another mapping, skip
  }

  // Find deleted raindrops (exist locally but not in Raindrop)
  for (const link of localLinks) {
    if (!raindropById.has(link.raindropId)) {
      // Raindrop was deleted - delete Firefox bookmark
      try {
        await browser.bookmarks.remove(link.firefoxId);
        await removeBookmarkLink(link.id);
        result.deleted++;
      } catch (error) {
        // Bookmark may already be deleted
        await removeBookmarkLink(link.id);
        result.deleted++;
      }
    }
  }

  // Update mapping last sync time
  await updateFolderMapping(mapping.id, { lastSync: Date.now() });

  return result;
}

// ==================== Push Sync (Firefox → Raindrop) ====================

export interface PushSyncResult {
  created: number;
  updated: number;
  errors: string[];
}

export async function pushToRaindrop(): Promise<PushSyncResult> {
  const result: PushSyncResult = {
    created: 0,
    updated: 0,
    errors: [],
  };

  const settings = await getSettings();
  if (!settings.enabled) {
    logger.debug('Sync is disabled');
    return result;
  }

  // Check if sync is already in progress
  const { isSyncInProgress } = await import('./bookmarkListeners');
  if (isSyncInProgress()) {
    logger.debug('Sync already in progress, skipping push');
    return result;
  }

  const mappings = await getFolderMappings();
  logger.info(`Starting push sync to Raindrop, mappings count: ${mappings.length}`);
  
  if (mappings.length === 0) {
    logger.debug('No folder mappings configured');
    return result;
  }

  setSyncing(true);

  try {
    for (const mapping of mappings) {
      try {
        const mappingResult = await pushSyncForMapping(mapping);
        result.created += mappingResult.created;
        result.updated += mappingResult.updated;
        result.errors.push(...mappingResult.errors);
      } catch (error) {
        const errorMsg = `Failed to push mapping ${mapping.folderName}: ${error}`;
        result.errors.push(errorMsg);
        logger.error(errorMsg);
      }
    }

    logger.info('Push sync completed', result);

    return result;
  } finally {
    setSyncing(false);
  }
}

async function pushSyncForMapping(
  mapping: FolderMapping
): Promise<PushSyncResult> {
  const result: PushSyncResult = {
    created: 0,
    updated: 0,
    errors: [],
  };

  // Check if folder exists first
  try {
    const folders = await browser.bookmarks.get(mapping.firefoxFolderId).catch(() => []);
    if (folders.length === 0) {
      logger.warn(`Mapping folder ${mapping.folderName} (${mapping.firefoxFolderId}) no longer exists`);
      result.errors.push(`Folder "${mapping.folderName}" not found in browser`);
      return result;
    }
  } catch (error) {
    logger.error(`Error checking folder existence: ${mapping.firefoxFolderId}`, error);
  }

  // Get Firefox bookmarks in this folder
  const firefoxBookmarks = await browser.bookmarks.getChildren(
    mapping.firefoxFolderId
  );
  
  const bookmarks = firefoxBookmarks.filter(
    (b) => (b.type === 'bookmark' || (!b.type && b.url)) && b.url
  );

  logger.info(`Push sync for mapping ${mapping.folderName}: found ${firefoxBookmarks.length} items, ${bookmarks.length} are valid bookmarks`);

  // Get all raindrops from collection for comparison
  const raindrops = await getAllRaindropsInCollection(
    mapping.raindropCollectionId
  );

  // Get ALL local bookmark links to avoid duplicates across all mappings
  const allLinks = await getBookmarkLinks();

  // Create URL map for raindrop lookup
  const raindropByUrl = new Map<string, Raindrop>();
  for (const raindrop of raindrops) {
    raindropByUrl.set(normalizeUrl(raindrop.link), raindrop);
  }

  // Create firefoxId map for link lookup (across all mappings)
  const linkByFirefoxId = new Map<string, BookmarkLink>();
  for (const link of allLinks) {
    linkByFirefoxId.set(link.firefoxId, link);
  }

  const toCreate: { bookmark: Bookmarks.BookmarkTreeNode; data: CreateRaindropData }[] = [];

  // Find bookmarks not yet synced to Raindrop
  for (const bookmark of bookmarks) {
    if (!bookmark.url) continue;

    // Skip internal browser URLs (about:, chrome:, etc.)
    if (!isValidSyncUrl(bookmark.url)) {
      logger.debug(`Skipping invalid URL: ${bookmark.url}`);
      continue;
    }

    const existingLink = linkByFirefoxId.get(bookmark.id);

    if (!existingLink) {
      // Check if already exists in Raindrop by URL
      const existingRaindrop = raindropByUrl.get(normalizeUrl(bookmark.url));

      if (existingRaindrop) {
        // Already exists - just create link
        const link: BookmarkLink = {
          id: generateId(),
          firefoxId: bookmark.id,
          raindropId: existingRaindrop._id,
          url: bookmark.url,
          title: bookmark.title,
          lastModified: Date.now(),
          contentHash: computeBookmarkHash(bookmark.url, bookmark.title),
          syncStatus: 'synced',
          mappingId: mapping.id,
        };
        await addBookmarkLink(link);
      } else {
        // Collect for bulk create
        toCreate.push({
          bookmark,
          data: {
            link: bookmark.url,
            title: bookmark.title,
            collection: { $id: mapping.raindropCollectionId },
          },
        });
      }
    }
  }

  // Bulk create bookmarks in Raindrop
  if (toCreate.length > 0) {
    try {
      logger.info(`Bulk creating ${toCreate.length} raindrops for ${mapping.folderName}`);
      const createdRaindrops = await createRaindrops(toCreate.map(item => item.data));
      
      for (let i = 0; i < createdRaindrops.length; i++) {
        const raindrop = createdRaindrops[i];
        const bookmark = toCreate[i].bookmark;
        
        if (!raindrop || !raindrop._id) continue;

        const link: BookmarkLink = {
          id: generateId(),
          firefoxId: bookmark.id,
          raindropId: raindrop._id,
          url: bookmark.url!,
          title: bookmark.title,
          lastModified: Date.now(),
          contentHash: computeBookmarkHash(bookmark.url!, bookmark.title),
          syncStatus: 'synced',
          mappingId: mapping.id,
        };
        await addBookmarkLink(link);
        result.created++;
      }
    } catch (error) {
      const errorMsg = `Bulk creation failed for ${mapping.folderName}: ${error}`;
      logger.error(errorMsg);
      result.errors.push(errorMsg);
    }
  }

  return result;
}

// ==================== Nested Folder Sync ====================

const MAX_SYNC_DEPTH = 5;

export async function syncFolderWithChildren(
  firefoxFolderId: string,
  raindropParentId: number | null,
  parentMappingId: string | null = null,
  depth = 0
): Promise<FolderMapping[]> {
  if (depth >= MAX_SYNC_DEPTH) {
    logger.warn(`Max sync depth (${MAX_SYNC_DEPTH}) reached, stopping recursion`);
    return [];
  }

  // Fetch all collections once and pass the cache down through recursion
  const collectionsCache = await getAllCollections();
  return _syncFolderWithChildrenCached(
    firefoxFolderId,
    raindropParentId,
    parentMappingId,
    depth,
    collectionsCache
  );
}

async function _syncFolderWithChildrenCached(
  firefoxFolderId: string,
  raindropParentId: number | null,
  parentMappingId: string | null,
  depth: number,
  collectionsCache: Collection[]
): Promise<FolderMapping[]> {
  if (depth >= MAX_SYNC_DEPTH) {
    logger.warn(`Max sync depth (${MAX_SYNC_DEPTH}) reached, stopping recursion`);
    return [];
  }

  const mappings: FolderMapping[] = [];
  const children = await browser.bookmarks.getChildren(firefoxFolderId);

  for (const child of children) {
    if (child.type === 'folder') {
      let collectionId: number;
      let collectionName = child.title;

      // Search in cache instead of making API calls per subfolder
      const existingCollection = collectionsCache.find((c) => {
        const matchesTitle = c.title.toLowerCase() === child.title.toLowerCase();
        const matchesParent = raindropParentId
          ? c.parent?.$id === raindropParentId
          : c.parent === null;
        return matchesTitle && matchesParent;
      });

      if (existingCollection) {
        collectionId = existingCollection._id;
        collectionName = existingCollection.title;
      } else {
        const newCollection = await createCollection({
          title: child.title,
          parent: raindropParentId ? { $id: raindropParentId } : undefined,
        });
        collectionId = newCollection._id;
        collectionsCache.push(newCollection); // add to cache for subsequent lookups
      }

      const mapping: FolderMapping = {
        id: generateId(),
        firefoxFolderId: child.id,
        raindropCollectionId: collectionId,
        folderName: child.title,
        raindropCollectionName: collectionName,
        parentMappingId: parentMappingId || undefined,
        depth: depth + 1,
        lastSync: 0,
        syncChildren: true,
      };

      await addFolderMapping(mapping);
      mappings.push(mapping);

      const childMappings = await _syncFolderWithChildrenCached(
        child.id,
        collectionId,
        mapping.id,
        depth + 1,
        collectionsCache
      );
      mappings.push(...childMappings);
    }
  }

  return mappings;
}

// ==================== Full Re-sync ====================

export async function performFullResync(): Promise<{
  success: boolean;
  results: InitialSyncResult[];
  errors: string[];
}> {
  const results: InitialSyncResult[] = [];
  const errors: string[] = [];

  const mappings = await getFolderMappings();

  if (mappings.length === 0) {
    return { success: true, results: [], errors: ['No mappings configured'] };
  }

  // Clear existing links
  await saveBookmarkLinks([]);

  // Clear queue to avoid duplicate processing of old events
  const { clearQueue } = await import('./storage');
  await clearQueue();

  for (const mapping of mappings) {
    try {
      const result = await performInitialSync(mapping);
      results.push(result);
    } catch (error) {
      errors.push(`Failed to sync ${mapping.folderName}: ${error}`);
    }
  }

  await updateSettings({ lastFullSync: Date.now() });

  return {
    success: errors.length === 0,
    results,
    errors,
  };
}

// ==================== Periodic Sync Setup ====================

let syncAlarmName = 'raindrop-sync-interval';

export async function setupPeriodicSync(): Promise<void> {
  const settings = await getSettings();

  if (settings.enabled && settings.syncInterval > 0) {
    // Only create alarm if it doesn't exist or the interval changed.
    // Avoids resetting the timer on every Service Worker restart in Chrome MV3.
    const existing = await browser.alarms.get(syncAlarmName);
    if (!existing || existing.periodInMinutes !== settings.syncInterval) {
      await browser.alarms.clear(syncAlarmName);
      await browser.alarms.create(syncAlarmName, {
        periodInMinutes: settings.syncInterval,
      });
      logger.info(`Periodic sync set up: every ${settings.syncInterval} minutes`);
    }
  } else {
    await browser.alarms.clear(syncAlarmName);
  }
}

export async function handleSyncAlarm(
  alarm: Alarms.Alarm
): Promise<void> {
  if (alarm.name === syncAlarmName) {
    logger.info('Periodic sync triggered');
    await pullFromRaindrop();
  }
}

// ==================== Status ====================

// Re-export SyncStatus for consumers that import from syncManager
export type { SyncStatus } from '../types/messages';

// Cache username to avoid API call on every popup open
let cachedUserName: string | undefined;

export function clearCachedUser(): void {
  cachedUserName = undefined;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const isAuth = await checkIsAuthenticated();
  const settings = await getSettings();
  const mappings = await getFolderMappings();
  const links = await getBookmarkLinks();
  const stats = await getSyncStats();
  const { isSyncInProgress } = await import('./bookmarkListeners');

  let userName: string | undefined;

  if (isAuth) {
    if (cachedUserName) {
      userName = cachedUserName;
    } else {
      try {
        const user = await getCurrentUser();
        cachedUserName = user.fullName;
        userName = cachedUserName;
      } catch {
        // Token may be invalid
      }
    }
  } else {
    cachedUserName = undefined;
  }

  return {
    isAuthenticated: isAuth,
    isEnabled: settings.enabled,
    isSyncing: isSyncInProgress(),
    mappingsCount: mappings.length,
    linksCount: links.length,
    lastSyncTime: stats.lastSyncTime,
    lastSyncStatus: stats.lastSyncStatus,
    pendingOperations: stats.pendingOperations,
    userName,
  };
}

