// Background Script - Main Entry Point

import browser from 'webextension-polyfill';
import { logger } from '../utils/logger';
import { getSettings, isAuthenticated, getApiToken, saveApiToken, clearApiToken } from './storage';
import {
  registerBookmarkListeners,
  unregisterBookmarkListeners,
} from './bookmarkListeners';
import { queueProcessor } from './queue';
import {
  setupPeriodicSync,
  handleSyncAlarm,
  pullFromRaindrop,
  pushToRaindrop,
  performInitialSync,
  performFullResync,
  getSyncStatus,
  syncFolderWithChildren,
  clearCachedUser,
} from './syncManager';
import {
  logout,
  getCurrentUser,
  getRootCollections,
  getChildCollections,
  getAllCollections,
} from './raindropApi';
import { MessageRequest, MessageResponse } from '../types/messages';

// ==================== Initialization ====================

async function initialize(): Promise<void> {
  logger.info('Raindrop Bookmark Sync extension starting...');

  try {
    // Load settings and set debug mode
    const settings = await getSettings();
    logger.setDebugMode(settings.debugMode);

    // Always start sync services (they check internally for auth/enabled)
    await queueProcessor.start();
    await setupPeriodicSync();

    logger.info('Sync services started');
  } catch (error) {
    logger.error('Initialization failed', error);
  }
}

// ==================== Message Handlers ====================

async function handleMessage(
  request: MessageRequest
): Promise<MessageResponse> {
  logger.debug('Received message', request);

  try {
    switch (request.action) {
      // ==================== Auth ====================
      case 'logout':
        await logout();
        clearCachedUser();
        unregisterBookmarkListeners();
        queueProcessor.stop();
        await browser.alarms.clearAll();
        return { success: true };

      case 'isAuthenticated':
        const isAuth = await isAuthenticated();
        return { success: true, data: isAuth };

      case 'getUser':
        const user = await getCurrentUser();
        return { success: true, data: user };

      // ==================== API Token ====================
      case 'getApiToken':
        const token = await getApiToken();
        return { success: true, data: { hasToken: !!token } };

      case 'saveApiToken':
        await saveApiToken(request.data as string);
        return { success: true };

      case 'clearApiToken':
        await clearApiToken();
        clearCachedUser();
        return { success: true };

      // ==================== Settings ====================
      case 'getSettings':
        const settings = await getSettings();
        return { success: true, data: settings };

      case 'updateSettings':
        const { updateSettings } = await import('./storage');
        const newSettings = await updateSettings(
          request.data as Record<string, unknown>
        );

        // Apply settings changes
        if (newSettings.enabled) {
          registerBookmarkListeners();
          queueProcessor.start();
          await setupPeriodicSync();
        } else {
          unregisterBookmarkListeners();
          queueProcessor.stop();
          await browser.alarms.clear('raindrop-sync-interval');
        }

        logger.setDebugMode(newSettings.debugMode);

        return { success: true, data: newSettings };

      // ==================== Collections ====================
      case 'getCollections':
        const collections = await getAllCollections();
        return { success: true, data: collections };

      case 'getRootCollections':
        const rootCollections = await getRootCollections();
        return { success: true, data: rootCollections };

      case 'getChildCollections':
        const childCollections = await getChildCollections();
        return { success: true, data: childCollections };

      // ==================== Folder Mappings ====================
      case 'getFolderMappings':
        const { getFolderMappings } = await import('./storage');
        const mappings = await getFolderMappings();
        return { success: true, data: mappings };

      case 'addFolderMapping':
        const { addFolderMapping } = await import('./storage');
        const addedMappings = await addFolderMapping(
          request.data as import('../types/storage').FolderMapping
        );
        return { success: true, data: addedMappings };

      case 'removeFolderMapping':
        const { removeFolderMapping } = await import('./storage');
        await removeFolderMapping(request.data as string);
        return { success: true };

      case 'syncFolderWithChildren':
        const syncData = request.data as {
          firefoxFolderId: string;
          raindropParentId: number | null;
        };
        const childMappings = await syncFolderWithChildren(
          syncData.firefoxFolderId,
          syncData.raindropParentId
        );
        return { success: true, data: childMappings };

      // ==================== Sync ====================
      case 'getSyncStatus':
        const status = await getSyncStatus();
        return { success: true, data: status };

      case 'triggerSync':
        // Full sync: push local changes then pull remote changes
        logger.info('Manual sync triggered');
        
        try {
          // First, process any pending operations in the queue
          await queueProcessor.processQueue();

          // Then ensure all existing bookmarks in mapped folders are synced
          const { getFolderMappings, getBookmarkLinksForMapping } = await import('./storage');
          const mappingsForSync = await getFolderMappings();
          
          for (const mapping of mappingsForSync) {
            // Check if this mapping has any links - if not, perform initial sync
            const existingLinks = await getBookmarkLinksForMapping(mapping.id);
            
            if (existingLinks.length === 0) {
              logger.info(`No links found for mapping ${mapping.folderName}, performing initial sync`);
              await performInitialSync(mapping);
            }
          }
          
          // Then do push/pull for everything else
          const pushResult = await pushToRaindrop();
          const pullResult = await pullFromRaindrop();
          
          // Wait a moment for storage to settle
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Get updated stats and status
          const { getSyncStats } = await import('./storage');
          const updatedStats = await getSyncStats();
          const updatedStatus = await getSyncStatus();
          
          return {
            success: true,
            data: {
              push: pushResult,
              pull: pullResult,
              stats: updatedStats,
              status: updatedStatus
            }
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error('Sync failed', error);
          return { success: false, error: errorMessage };
        }

      case 'performInitialSync':
        const mapping = request.data as import('../types/storage').FolderMapping;
        const initialResult = await performInitialSync(mapping);
        return { success: true, data: initialResult };

      case 'performFullResync':
        const fullResult = await performFullResync();
        return { success: true, data: fullResult };

      // ==================== Firefox Bookmarks ====================
      case 'getFirefoxBookmarkTree':
        const tree = await browser.bookmarks.getTree();
        return { success: true, data: tree };

      case 'getFirefoxFolder':
        const folderId = request.data as string;
        const folder = await browser.bookmarks.getSubTree(folderId);
        return { success: true, data: folder };

      // ==================== Stats ====================
      case 'getSyncStats':
        const { getSyncStats } = await import('./storage');
        const stats = await getSyncStats();
        return { success: true, data: stats };

      case 'clearSyncErrors':
        const { clearSyncErrors } = await import('./storage');
        await clearSyncErrors();
        return { success: true };

      // ==================== Queue ====================
      case 'getQueue':
        const { getQueue } = await import('./storage');
        const queue = await getQueue();
        return { success: true, data: queue };

      case 'retryFailed':
        const { retryFailed } = await import('./storage');
        await retryFailed();
        queueProcessor.forceProcess();
        return { success: true };

      case 'clearQueue':
        const { clearQueue } = await import('./storage');
        await clearQueue();
        return { success: true };

      // ==================== Debug ====================
      case 'exportData':
        const { exportData } = await import('./storage');
        const exportedData = await exportData();
        return { success: true, data: exportedData };

      case 'getLogHistory':
        return { success: true, data: logger.getHistory() };

      default:
        return { success: false, error: `Unknown action: ${request.action}` };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Message handler error: ${request.action}`, error);
    return { success: false, error: errorMessage };
  }
}

// ==================== Event Listeners ====================

// Message listener for popup and options page
browser.runtime.onMessage.addListener((request: any) => {
  // Returning a Promise is supported by webextension-polyfill 
  // and is the recommended way to handle async messages in MV3.
  return handleMessage(request);
});

// Alarm listener for periodic sync and queue processing.
// MUST return a Promise so Chrome MV3 keeps the Service Worker alive
// until the async work completes.
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'process-queue') {
    return queueProcessor.processQueue();
  } else {
    return handleSyncAlarm(alarm);
  }
});

// Installation/update listener
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    logger.info('Extension installed');
    // Open options page on first install
    browser.runtime.openOptionsPage();
  } else if (details.reason === 'update') {
    logger.info(`Extension updated to version ${browser.runtime.getManifest().version}`);
  }
});

// Startup listener
browser.runtime.onStartup.addListener(() => {
  logger.info('Browser started');
  initialize();
});

// ==================== Start ====================

// Register listeners at top level for MV3 compatibility
registerBookmarkListeners();

// Initialize on script load
initialize();
