// Background Script - Main Entry Point

import browser from 'webextension-polyfill';
import { logger } from '../utils/logger';
import { getSettings, isAuthenticated, getApiToken, saveApiToken, clearApiToken, resetLocalState } from './storage';
import {
  registerBookmarkListeners,
  unregisterBookmarkListeners,
} from './bookmarkListeners';
import {
  setupPeriodicSync,
  handleSyncAlarm,
  reconcileAllMappings,
  performInitialSync,
  performFullResync,
  getSyncStatus,
  syncFolderWithChildren,
  clearCachedUser,
  propagateBrowserFolderDeletions,
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

    // No mapping, no sync (task 012): normalize a stale enabled=true left over
    // with zero mappings (e.g. from before this rule) so it can't silently
    // resume when a mapping is next added.
    const { disableAutoSyncIfNoMappings } = await import('./storage');
    await disableAutoSyncIfNoMappings();

    // Always start sync services (they check internally for auth/enabled)
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
        // Disconnect = full teardown. Stop all background activity FIRST so
        // nothing writes back into storage after the wipe, then blank-slate the
        // extension's local state (task 011). Browser folders + Raindrop
        // collections are the user's data and are left untouched.
        await logout();
        clearCachedUser();
        unregisterBookmarkListeners();
        await browser.alarms.clearAll();
        await resetLocalState();
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
        const { updateSettings, getFolderMappings: getMappingsForGuard } = await import('./storage');
        let settingsUpdates = request.data as Record<string, unknown>;
        // No mapping, no sync (task 012): never let sync be enabled with zero
        // mappings, whatever asked (the popup has its own toggle). Authoritative
        // guard so every path is covered, not just the options UI.
        if (
          settingsUpdates.enabled === true &&
          (await getMappingsForGuard()).length === 0
        ) {
          settingsUpdates = { ...settingsUpdates, enabled: false };
        }
        const newSettings = await updateSettings(settingsUpdates);

        // Apply settings changes
        if (newSettings.enabled) {
          registerBookmarkListeners();
          await setupPeriodicSync();
        } else {
          unregisterBookmarkListeners();
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
        const { removeFolderMapping, disableAutoSyncIfNoMappings } = await import('./storage');
        await removeFolderMapping(request.data as string);
        // No mappings left → nothing to sync: force auto-sync off and tear down
        // the auto-sync services (task 012), mirroring the disable path in
        // updateSettings so the periodic alarm/listeners don't run against nothing.
        if (await disableAutoSyncIfNoMappings()) {
          unregisterBookmarkListeners();
          await browser.alarms.clear('raindrop-sync-interval');
        }
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
        // One unified three-way reconcile (task 014): deletion propagation,
        // tree reconciliation, per-object direction and union of never-synced
        // mappings all happen inside reconcileAllMappings.
        logger.info('Manual sync triggered');

        try {
          const r = await reconcileAllMappings();

          // Get updated stats and status
          const { getSyncStats } = await import('./storage');
          const updatedStats = await getSyncStats();
          const updatedStatus = await getSyncStatus();

          return {
            success: true,
            data: {
              // UI-compatible shape (popup/options read push/pull counts)
              push: {
                created: r.createdInRaindrop,
                updated: r.pushed,
                deleted: r.deletedInRaindrop,
                errors: r.errors,
              },
              pull: {
                created: r.createdInBrowser + r.adopted,
                updated: r.pulled,
                deleted: r.deletedInBrowser,
                errors: [],
              },
              stats: updatedStats,
              status: updatedStatus,
            },
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

      case 'getSyncErrors':
        const { getSyncErrors } = await import('./storage');
        const syncErrors = await getSyncErrors();
        return { success: true, data: syncErrors };

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

// Alarm listener for the periodic reconcile.
// MUST return a Promise so Chrome MV3 keeps the Service Worker alive
// until the async work completes.
browser.alarms.onAlarm.addListener((alarm) => handleSyncAlarm(alarm));

// Installation/update listener
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    logger.info('Extension installed');
    // Open options page on first install
    browser.runtime.openOptionsPage();
  } else if (details.reason === 'update') {
    logger.info(`Extension updated to version ${browser.runtime.getManifest().version}`);
    // Migration: the operation queue was removed in 014. Clear its leftover
    // 1-minute alarm so an upgraded install stops firing a now-ignored event.
    void browser.alarms.clear('process-queue');
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
