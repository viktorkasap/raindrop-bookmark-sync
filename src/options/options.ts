// Options Page Script

import browser, { Bookmarks } from 'webextension-polyfill';
import { FolderMapping, SyncSettings, SyncStats, SyncErrorEntry, DEFAULT_SYNC_SETTINGS } from '../types/storage';
import type { InitialSyncResult } from '../background/syncManager';
import { Collection } from '../types/raindrop';
import { generateId } from '../utils/hash';
import { isFolderNode } from '../utils/bookmarkNode';
import { MessageResponse } from '../types/messages';
import { storageChangeReloads } from './liveRefresh';

// Send message to background script
async function sendMessage(
  action: string,
  data?: unknown
): Promise<MessageResponse> {
  return browser.runtime.sendMessage({ action, data });
}

// DOM Elements
const connectionStatus = document.getElementById('connection-status')!;
const apiTokenInput = document.getElementById('api-token') as HTMLInputElement;
const saveTokenBtn = document.getElementById('save-token-btn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
const firefoxFolderSelect = document.getElementById('firefox-folder') as HTMLSelectElement;
const raindropCollectionSelect = document.getElementById('raindrop-collection') as HTMLSelectElement;
const addMappingBtn = document.getElementById('add-mapping-btn') as HTMLButtonElement;
const mappingsList = document.getElementById('mappings-list')!;
const enableSyncToggle = document.getElementById('enable-sync') as HTMLInputElement;
const syncIntervalSelect = document.getElementById('sync-interval') as HTMLSelectElement;
const debugModeToggle = document.getElementById('debug-mode') as HTMLInputElement;
const statTotal = document.getElementById('stat-total')!;
const statLastSync = document.getElementById('stat-last-sync')!;
const syncNowBtn = document.getElementById('sync-now-btn') as HTMLButtonElement;
const fullResyncBtn = document.getElementById('full-resync-btn') as HTMLButtonElement;
const syncStatusMsg = document.getElementById('sync-status-msg') as HTMLElement;
const syncErrorsList = document.getElementById('sync-errors-list')!;
const versionEl = document.getElementById('version')!;

// State
let isConnected = false;
let firefoxFolders: Bookmarks.BookmarkTreeNode[] = [];
let raindropCollections: Collection[] = [];
let currentMappings: FolderMapping[] = [];

// Initialize
async function initialize(): Promise<void> {
  const manifest = browser.runtime.getManifest();
  versionEl.textContent = manifest.version;

  await checkConnection();
  await loadSettings();
  await loadStats();
  await loadSyncErrors();

  // Mappings are shown even while disconnected (read-only) — they live in
  // local storage and carry their own display names, so no token is needed.
  await loadMappings();

  if (isConnected) {
    await loadFirefoxFolders();
    await loadRaindropCollections();
  }

  setupEventListeners();
  setupLiveRefresh();
}

// Keep the page in sync with external state changes so it never goes stale
// while left open (background sync alarm, folder-deletion cascade, popup, or a
// second tab). Two independent sources of staleness:
//   1. storage.local — mappings list, settings, stats.
//   2. the browser bookmark tree — the "Firefox folder" picker (not in storage,
//      so storage.onChanged can't see it; needs bookmarks events).
let folderReloadTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFolderReload(): void {
  // The picker is only populated while connected; skip otherwise.
  if (!isConnected) return;
  if (folderReloadTimer) clearTimeout(folderReloadTimer);
  // Debounce: a single sync fires many bookmark events in a burst.
  folderReloadTimer = setTimeout(() => {
    void loadFirefoxFolders();
  }, 400);
}

// storage.onChanged can fire in bursts: one sync writes `lastSync` per mapping
// (N writes) plus a stats write, so a large tree would trigger N unthrottled
// loadMappings()/loadStats() message round-trips to the background SW. Coalesce
// the pending sections and reload once per burst.
let storageReloadTimer: ReturnType<typeof setTimeout> | undefined;
const pendingReload = { mappings: false, settings: false, stats: false, errors: false };

function scheduleStorageReload(plan: {
  mappings: boolean;
  settings: boolean;
  stats: boolean;
  errors: boolean;
}): void {
  pendingReload.mappings ||= plan.mappings;
  pendingReload.settings ||= plan.settings;
  pendingReload.stats ||= plan.stats;
  pendingReload.errors ||= plan.errors;
  if (
    !pendingReload.mappings &&
    !pendingReload.settings &&
    !pendingReload.stats &&
    !pendingReload.errors
  ) {
    return;
  }
  if (storageReloadTimer) clearTimeout(storageReloadTimer);
  storageReloadTimer = setTimeout(() => {
    if (pendingReload.mappings) void loadMappings();
    if (pendingReload.settings) void loadSettings();
    if (pendingReload.stats) void loadStats();
    if (pendingReload.errors) void loadSyncErrors();
    pendingReload.mappings = false;
    pendingReload.settings = false;
    pendingReload.stats = false;
    pendingReload.errors = false;
  }, 300);
}

function setupLiveRefresh(): void {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    scheduleStorageReload(storageChangeReloads(changes as Record<string, unknown>));
  });

  browser.bookmarks.onCreated.addListener(scheduleFolderReload);
  browser.bookmarks.onRemoved.addListener(scheduleFolderReload);
  browser.bookmarks.onChanged.addListener(scheduleFolderReload);
  browser.bookmarks.onMoved.addListener(scheduleFolderReload);
}

// Check connection status by verifying the token works
async function checkConnection(): Promise<void> {
  try {
    const authResponse = await sendMessage('isAuthenticated');

    if (authResponse.success && authResponse.data) {
      // Token exists, verify it works by fetching user
      const userResponse = await sendMessage('getUser');

      if (userResponse.success && userResponse.data) {
        const user = userResponse.data as { fullName: string };
        showConnectedState(user.fullName);
        return;
      }
    }
    showDisconnectedState();
  } catch (error) {
    console.error('Failed to check connection:', error);
    showDisconnectedState();
  }
}

function showConnectedState(userName?: string): void {
  isConnected = true;

  const statusIndicator = connectionStatus.querySelector('.status-indicator')!;
  const statusText = connectionStatus.querySelector('.status-text')!;

  statusIndicator.classList.remove('disconnected');
  statusIndicator.classList.add('connected');
  statusText.textContent = userName ? `Connected as ${userName}` : 'Connected';

  apiTokenInput.placeholder = 'Token saved (enter new to replace)';
  apiTokenInput.value = '';
  saveTokenBtn.textContent = 'Update Token';
  disconnectBtn.classList.remove('hidden');
  renderMappings(); // re-render so Remove buttons reflect the new mode (also re-gates)
}

// Gate controls by BOTH a working connection and having something to sync.
// Adding the first mapping needs only a connection (task 007). Everything that
// actually syncs — the Enable Sync toggle, the interval, and all Actions —
// also needs at least one mapping: no mapping, no sync (task 012). Debug Mode
// stays free (local logging, useful while troubleshooting).
function refreshControlGating(): void {
  const canManage = isConnected; // add the first mapping
  const canSync = isConnected && currentMappings.length > 0;

  addMappingBtn.disabled = !canManage;

  enableSyncToggle.disabled = !canSync;
  syncIntervalSelect.disabled = !canSync;
  syncNowBtn.disabled = !canSync;
  fullResyncBtn.disabled = !canSync;

  // With nothing to sync the toggle must read OFF, never a stuck "on but
  // greyed" (the background also forces enabled=false when the last mapping
  // goes, so this just mirrors that state).
  if (!canSync) enableSyncToggle.checked = false;
}

// Non-blocking inline feedback near the action buttons. This is the ONLY way
// the options page tells the user anything — we never use alert()/confirm(),
// which throw a blocking "The extension … says" modal (see armConfirm for the
// destructive-action replacement).
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(message: string, isError = false): void {
  syncStatusMsg.textContent = message;
  syncStatusMsg.classList.toggle('is-error', isError);
  if (toastTimer) clearTimeout(toastTimer);
  // Errors linger longer; a plain "nothing to sync" fades quickly.
  toastTimer = setTimeout(() => {
    syncStatusMsg.textContent = '';
    syncStatusMsg.classList.remove('is-error');
  }, isError ? 12000 : 6000);
}

// Non-blocking replacement for confirm() on destructive actions. First click
// arms the button (swaps its label to `confirmText` for ~3s); a second click
// within that window runs `action`. No modal, but a stray single click can't
// destroy anything.
const armTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
function armConfirm(
  btn: HTMLButtonElement,
  confirmText: string,
  action: () => void | Promise<void>
): void {
  const existing = armTimers.get(btn);
  if (existing) {
    // Second click within the window → confirmed.
    clearTimeout(existing);
    armTimers.delete(btn);
    btn.classList.remove('confirming');
    btn.textContent = btn.dataset.armLabel ?? btn.textContent;
    delete btn.dataset.armLabel;
    void action();
    return;
  }
  // First click → arm.
  btn.dataset.armLabel = btn.textContent ?? '';
  btn.textContent = confirmText;
  btn.classList.add('confirming');
  const timer = setTimeout(() => {
    armTimers.delete(btn);
    btn.classList.remove('confirming');
    btn.textContent = btn.dataset.armLabel ?? '';
    delete btn.dataset.armLabel;
  }, 3000);
  armTimers.set(btn, timer);
}

// Honest "Sync Now" summary from the triggerSync result — real counts, not a
// blanket "completed successfully" that lies when nothing happened (task 007).
function summarizeSync(data: unknown): string {
  const d = (data ?? {}) as {
    push?: { created?: number; updated?: number; deleted?: number; errors?: string[] };
    pull?: { created?: number; updated?: number; deleted?: number; errors?: string[] };
  };
  const push = d.push ?? {};
  const pull = d.pull ?? {};
  const pulled = pull.created ?? 0;
  const pushed = push.created ?? 0;
  const updated = (push.updated ?? 0) + (pull.updated ?? 0);
  // push.deleted = browser deletions propagated to Raindrop;
  // pull.deleted = raindrop deletions propagated to the browser.
  const removed = (push.deleted ?? 0) + (pull.deleted ?? 0);
  const errors = [...(push.errors ?? []), ...(pull.errors ?? [])];

  const parts: string[] = [];
  if (pulled) parts.push(`↓ ${pulled} pulled`);
  if (pushed) parts.push(`↑ ${pushed} pushed`);
  if (updated) parts.push(`${updated} updated`);
  if (removed) parts.push(`${removed} removed`);

  const summary = parts.length
    ? `Sync complete — ${parts.join(', ')}.`
    : 'Already up to date — nothing to sync.';

  return errors.length
    ? `${summary}\n\n${errors.length} error(s):\n${errors.slice(0, 10).join('\n')}`
    : summary;
}

function showDisconnectedState(): void {
  isConnected = false;

  const statusIndicator = connectionStatus.querySelector('.status-indicator')!;
  const statusText = connectionStatus.querySelector('.status-text')!;

  statusIndicator.classList.remove('connected');
  statusIndicator.classList.add('disconnected');
  statusText.textContent = 'Not connected';

  apiTokenInput.placeholder = 'Paste your test token here...';
  saveTokenBtn.textContent = 'Save & Connect';
  disconnectBtn.classList.add('hidden');

  // Disconnect is a blank slate (task 011): the background wiped all mappings,
  // links and settings. Reflect that immediately — drop the in-memory mappings
  // and reset the sync toggle so the UI never shows phantom mappings or a
  // stuck "enabled" against no connection.
  currentMappings = [];
  enableSyncToggle.checked = false;
  syncIntervalSelect.value = DEFAULT_SYNC_SETTINGS.syncInterval.toString();
  renderMappings();
}

// Load settings
async function loadSettings(): Promise<void> {
  try {
    const response = await sendMessage('getSettings');

    if (response.success && response.data) {
      const settings = response.data as SyncSettings;
      enableSyncToggle.checked = settings.enabled;
      syncIntervalSelect.value = settings.syncInterval.toString();
      debugModeToggle.checked = settings.debugMode;
      // Re-gate: a settings-only live reload must not leave the toggle "on"
      // (or enabled) when there are no mappings to sync (task 012).
      refreshControlGating();
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// Load stats
async function loadStats(): Promise<void> {
  try {
    const response = await sendMessage('getSyncStats');

    if (response.success && response.data) {
      const stats = response.data as SyncStats;
      statTotal.textContent = stats.totalSynced.toString();
      statLastSync.textContent = stats.lastSyncTime > 0
        ? formatDate(stats.lastSyncTime)
        : 'Never';
    }
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// Load and render the sync errors panel (task 015). Reconcile replaces the
// stored set wholesale each pass, so this only ever shows the current pass's
// errors — a clean pass (e.g. a successful re-sync) clears the panel.
async function loadSyncErrors(): Promise<void> {
  try {
    const response = await sendMessage('getSyncErrors');
    if (!response.success) return;

    const errors = (response.data as SyncErrorEntry[]) ?? [];
    if (errors.length === 0) {
      syncErrorsList.innerHTML = '<p class="empty-state">No errors</p>';
      return;
    }

    syncErrorsList.innerHTML = errors
      .map(
        (e) => `
      <div class="sync-error-item">
        <span class="sync-error-type">${escapeHtml(e.type)}</span>
        <span class="sync-error-message">${escapeHtml(e.message)}</span>
      </div>
    `
      )
      .join('');
  } catch (error) {
    console.error('Failed to load sync errors:', error);
  }
}

// Load Firefox folders
async function loadFirefoxFolders(): Promise<void> {
  try {
    const response = await sendMessage('getFirefoxBookmarkTree');

    if (response.success && response.data) {
      const tree = response.data as Bookmarks.BookmarkTreeNode[];
      firefoxFolders = [];
      firefoxFolderSelect.innerHTML = '<option value="">Select a folder...</option>';

      // In-order DFS so options read top-to-bottom as the real tree. Indent
      // with non-breaking spaces (regular leading spaces get collapsed in
      // <option>). Keep the stored node's title CLEAN — addMapping derives
      // folderName from it and .trim() would not strip a nbsp prefix.
      function collectFolders(
        node: Bookmarks.BookmarkTreeNode,
        depth = 0
      ): void {
        const isRoot = node.id === '0' || node.id === 'root________';

        if (isFolderNode(node)) {
          if (!isRoot && node.title) {
            firefoxFolders.push(node);
            const option = document.createElement('option');
            option.value = node.id;
            const indent = '\u00A0\u00A0\u00A0\u00A0'.repeat(Math.max(0, depth - 1));
            const prefix = depth > 1 ? '\u21B3 ' : '';
            option.textContent = indent + prefix + node.title;
            firefoxFolderSelect.appendChild(option);
          }

          if (node.children) {
            for (const child of node.children) {
              collectFolders(child, depth + 1);
            }
          }
        }
      }

      for (const root of tree) {
        collectFolders(root, 0);
      }
    }
  } catch (error) {
    console.error('Failed to load Firefox folders:', error);
  }
}

// Load Raindrop collections
async function loadRaindropCollections(): Promise<void> {
  try {
    const response = await sendMessage('getCollections');

    if (response.success && response.data) {
      raindropCollections = response.data as Collection[];

      raindropCollectionSelect.innerHTML = '<option value="">Select a collection...</option>';

      const createOption = document.createElement('option');
      createOption.value = 'new';
      createOption.textContent = '+ Create new collection';
      raindropCollectionSelect.appendChild(createOption);

      // Render the collection tree in depth order (DFS), indented per level so
      // nesting is visible. Regular leading spaces collapse in <option>, so
      // indent with non-breaking spaces.
      const byTitle = (a: Collection, b: Collection) => a.title.localeCompare(b.title);
      const childrenOf = (parentId: number | null): Collection[] =>
        raindropCollections
          .filter((c) => (c.parent?.$id ?? null) === parentId)
          .sort(byTitle);

      const seen = new Set<number>();
      const appendCollection = (collection: Collection, depth: number): void => {
        if (seen.has(collection._id)) return; // guard against cyclic parent refs
        seen.add(collection._id);
        const option = document.createElement('option');
        option.value = collection._id.toString();
        const indent = '\u00A0\u00A0\u00A0\u00A0'.repeat(depth);
        const prefix = depth > 0 ? '\u21B3 ' : '';
        option.textContent = indent + prefix + collection.title;
        raindropCollectionSelect.appendChild(option);
        for (const child of childrenOf(collection._id)) {
          appendCollection(child, depth + 1);
        }
      };

      for (const root of childrenOf(null)) {
        appendCollection(root, 0);
      }
      // Orphans (parent not in the returned set) — show at root level, not lost.
      for (const collection of raindropCollections.slice().sort(byTitle)) {
        if (!seen.has(collection._id)) appendCollection(collection, 0);
      }
    }
  } catch (error) {
    console.error('Failed to load Raindrop collections:', error);
  }
}

// Load mappings
async function loadMappings(): Promise<void> {
  try {
    const response = await sendMessage('getFolderMappings');

    if (response.success && response.data) {
      currentMappings = response.data as FolderMapping[];
      renderMappings();
    }
  } catch (error) {
    console.error('Failed to load mappings:', error);
  }
}

// Render mappings list
function renderMappings(): void {
  // Re-gate on every render so adding/removing a mapping (or connect/disconnect)
  // updates the sync controls — no mapping, no sync (task 012).
  refreshControlGating();

  // Only the folders the user explicitly connected (roots) are shown. Nested
  // subfolders sync automatically as part of their root's subtree \u2014 they are
  // an implementation detail, not separately managed. Removing a root cascades
  // to its children.
  const rootMappings = currentMappings.filter((m) => m.depth === 0);

  if (rootMappings.length === 0) {
    mappingsList.innerHTML = '<p class="empty-state">No mappings configured</p>';
    return;
  }

  // Disconnect wipes all mappings (task 011), so a rendered list only ever
  // happens while connected \u2014 no read-only reference mode to show anymore.
  mappingsList.innerHTML =
    rootMappings
      .map(
        (mapping) => `
      <div class="mapping-item" data-id="${mapping.id}">
        <div class="mapping-info">
          <div class="mapping-folder">
            <span class="mapping-icon">\uD83D\uDCC1</span>
            <span class="mapping-name">${escapeHtml(mapping.folderName)}</span>
          </div>
          <span class="mapping-arrow">\u2192</span>
          <div class="mapping-collection">
            <span class="mapping-icon">\uD83C\uDF27\uFE0F</span>
            <span class="mapping-name">${escapeHtml(mapping.raindropCollectionName)}</span>
          </div>
        </div>
        <button class="remove-mapping-btn" data-id="${mapping.id}"${isConnected ? '' : ' disabled'}>Remove</button>
      </div>
    `
      )
      .join('');

  if (isConnected) {
    mappingsList.querySelectorAll('.remove-mapping-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const mappingId = target.dataset.id;
        if (!mappingId) return;
        armConfirm(target, 'Click again to confirm', () => removeMapping(mappingId));
      });
    });
  }
}

// Add mapping
async function addMapping(): Promise<void> {
  const firefoxFolderId = firefoxFolderSelect.value;
  const collectionValue = raindropCollectionSelect.value;

  if (!firefoxFolderId || !collectionValue) {
    showToast('Please select both a browser folder and a Raindrop collection', true);
    return;
  }

  const folder = firefoxFolders.find((f) => f.id === firefoxFolderId);
  if (!folder) {
    showToast('Selected folder not found', true);
    return;
  }

  let collectionId: number;
  let collectionName: string;

  if (collectionValue === 'new') {
    showToast('Creating new collections is not yet implemented — select an existing collection.', true);
    return;
  } else {
    collectionId = parseInt(collectionValue, 10);
    const collection = raindropCollections.find((c) => c._id === collectionId);
    collectionName = collection?.title || 'Unknown';
  }

  const mapping: FolderMapping = {
    id: generateId(),
    firefoxFolderId,
    raindropCollectionId: collectionId,
    folderName: folder.title?.trim() || 'Unnamed Folder',
    raindropCollectionName: collectionName,
    depth: 0,
    lastSync: 0,
  };

  try {
    addMappingBtn.textContent = 'Adding...';
    addMappingBtn.disabled = true;

    const addResponse = await sendMessage('addFolderMapping', mapping);
    if (!addResponse.success) {
      throw new Error(addResponse.error || 'Failed to add folder mapping');
    }

    // Initial sync reconciles the whole nested tree itself (both
    // directions) — one call, no separate syncFolderWithChildren
    // round-trip (task 001). Every mapped folder syncs all its children.
    const syncResponse = await sendMessage('performInitialSync', mapping);
    if (!syncResponse.success) {
      throw new Error(syncResponse.error || 'Failed to perform initial sync');
    }

    const syncResult = syncResponse.data as InitialSyncResult;

    if (syncResult.errors && syncResult.errors.length > 0) {
      showToast(`Mapping added, but some bookmarks failed to sync: ${syncResult.errors.join('; ')}`, true);
    } else {
      showToast(`Mapping added — folders: ${syncResult.foldersSynced}, matched: ${syncResult.matched}, ↑Raindrop: ${syncResult.createdInRaindrop}, ↓Browser: ${syncResult.createdInFirefox}`);
    }

    await loadMappings();
    await loadStats();

    firefoxFolderSelect.value = '';
    raindropCollectionSelect.value = '';
  } catch (error) {
    console.error('Failed to add mapping:', error);
    showToast('Failed to add mapping. Please try again.', true);
  } finally {
    addMappingBtn.textContent = 'Add Mapping';
    addMappingBtn.disabled = false;
  }
}

// Remove mapping
async function removeMapping(mappingId: string): Promise<void> {
  try {
    const response = await sendMessage('removeFolderMapping', mappingId);
    if (response.success) {
      await loadMappings();
      await loadStats();
      showToast('Mapping removed.');
    } else {
      showToast('Failed to remove mapping: ' + (response.error || 'Unknown error'), true);
    }
  } catch (error) {
    console.error('Failed to remove mapping:', error);
    showToast('Failed to remove mapping', true);
  }
}

// Update settings
async function updateSettingsAction(updates: Partial<SyncSettings>): Promise<void> {
  try {
    await sendMessage('updateSettings', updates);
  } catch (error) {
    console.error('Failed to update settings:', error);
    showToast('Failed to save settings', true);
  }
}

// Setup event listeners
function setupEventListeners(): void {
  // Save token button
  saveTokenBtn.addEventListener('click', async () => {
    const token = apiTokenInput.value.trim();

    if (!token) {
      showToast('Please enter your Test Token', true);
      return;
    }

    saveTokenBtn.disabled = true;
    saveTokenBtn.textContent = 'Verifying...';

    try {
      // Save the token
      const saveResponse = await sendMessage('saveApiToken', token);
      if (!saveResponse.success) {
        throw new Error(saveResponse.error || 'Failed to save token');
      }

      // Verify it works by fetching user info
      const userResponse = await sendMessage('getUser');
      if (!userResponse.success) {
        // Token is invalid, clear it
        await sendMessage('clearApiToken');
        throw new Error('Invalid token. Please check your Test Token and try again.');
      }

      const user = userResponse.data as { fullName: string };
      showConnectedState(user.fullName);

      // Load data now that we're connected
      await loadFirefoxFolders();
      await loadRaindropCollections();
      await loadMappings();

      showToast(`Connected as ${user.fullName}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to connect';
      showToast(msg, true);
      showDisconnectedState();
    } finally {
      saveTokenBtn.disabled = false;
      if (isConnected) {
        saveTokenBtn.textContent = 'Update Token';
      } else {
        saveTokenBtn.textContent = 'Save & Connect';
      }
    }
  });

  // Disconnect button — two-click confirm instead of a blocking confirm().
  disconnectBtn.addEventListener('click', () => {
    armConfirm(disconnectBtn, 'Click again to disconnect & clear mappings', async () => {
      await sendMessage('logout');
      showDisconnectedState();
      showToast('Disconnected.');
    });
  });

  // Add mapping button
  addMappingBtn.addEventListener('click', addMapping);

  // Settings toggles
  enableSyncToggle.addEventListener('change', () => {
    updateSettingsAction({ enabled: enableSyncToggle.checked });
  });

  syncIntervalSelect.addEventListener('change', () => {
    updateSettingsAction({ syncInterval: parseInt(syncIntervalSelect.value, 10) });
  });

  debugModeToggle.addEventListener('change', () => {
    updateSettingsAction({ debugMode: debugModeToggle.checked });
  });

  // Action buttons
  syncNowBtn.addEventListener('click', async () => {
    if (!isConnected) {
      showToast('Not connected — add your Raindrop.io test token first.', true);
      return;
    }
    syncNowBtn.textContent = 'Syncing...';
    syncNowBtn.disabled = true;

    try {
      const response = await sendMessage('triggerSync');

      if (response.success) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await loadStats();
        showToast(summarizeSync(response.data));
      } else {
        showToast('Sync failed: ' + (response.error || 'Unknown error'), true);
      }
    } catch (error) {
      console.error('Sync error:', error);
      showToast('Failed to trigger sync', true);
    } finally {
      syncNowBtn.textContent = 'Sync Now';
      syncNowBtn.disabled = !isConnected;
      await loadStats();
    }
  });

  fullResyncBtn.addEventListener('click', () => {
    if (!isConnected) {
      showToast('Not connected — add your Raindrop.io test token first.', true);
      return;
    }
    // Two-click confirm: this resyncs every mapped folder.
    armConfirm(fullResyncBtn, 'Click again to resync all', async () => {
      fullResyncBtn.textContent = 'Resyncing...';
      fullResyncBtn.disabled = true;

      try {
        const response = await sendMessage('performFullResync');
        if (response.success) {
          showToast('Full resync completed successfully.');
        } else {
          showToast('Full resync failed: ' + response.error, true);
        }
        await loadStats();
      } catch (error) {
        showToast('Failed to perform full resync', true);
      } finally {
        fullResyncBtn.textContent = 'Full Resync';
        fullResyncBtn.disabled = !isConnected;
      }
    });
  });

}

// Utility functions
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initialize);
