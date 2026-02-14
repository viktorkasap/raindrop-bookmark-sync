// Options Page Script

import browser, { Bookmarks } from 'webextension-polyfill';
import { FolderMapping, SyncSettings, SyncStats, SyncError } from '../types/storage';
import { Collection } from '../types/raindrop';
import { generateId } from '../utils/hash';
import { MessageResponse } from '../types/messages';

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
const syncChildrenCheckbox = document.getElementById('sync-children') as HTMLInputElement;
const addMappingBtn = document.getElementById('add-mapping-btn') as HTMLButtonElement;
const mappingsList = document.getElementById('mappings-list')!;
const enableSyncToggle = document.getElementById('enable-sync') as HTMLInputElement;
const syncIntervalSelect = document.getElementById('sync-interval') as HTMLSelectElement;
const debugModeToggle = document.getElementById('debug-mode') as HTMLInputElement;
const statTotal = document.getElementById('stat-total')!;
const statPending = document.getElementById('stat-pending')!;
const statFailed = document.getElementById('stat-failed')!;
const statLastSync = document.getElementById('stat-last-sync')!;
const syncNowBtn = document.getElementById('sync-now-btn') as HTMLButtonElement;
const fullResyncBtn = document.getElementById('full-resync-btn') as HTMLButtonElement;
const retryFailedBtn = document.getElementById('retry-failed-btn') as HTMLButtonElement;
const clearErrorsBtn = document.getElementById('clear-errors-btn') as HTMLButtonElement;
const errorsList = document.getElementById('errors-list')!;
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

  if (isConnected) {
    await loadFirefoxFolders();
    await loadRaindropCollections();
    await loadMappings();
  }

  setupEventListeners();
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
      statPending.textContent = stats.pendingOperations.toString();
      statFailed.textContent = stats.failedOperations.toString();
      statLastSync.textContent = stats.lastSyncTime > 0
        ? formatDate(stats.lastSyncTime)
        : 'Never';

      renderErrors(stats.errors);
    }
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// Load Firefox folders
async function loadFirefoxFolders(): Promise<void> {
  try {
    const response = await sendMessage('getFirefoxBookmarkTree');

    if (response.success && response.data) {
      const tree = response.data as Bookmarks.BookmarkTreeNode[];
      firefoxFolders = [];

      function collectFolders(
        node: Bookmarks.BookmarkTreeNode,
        depth = 0
      ): void {
        const isRoot = node.id === '0' || node.id === 'root________';

        if (node.type === 'folder' || (node.children && !node.url)) {
          if (!isRoot && node.title) {
            firefoxFolders.push({ ...node, title: '  '.repeat(Math.max(0, depth - 1)) + node.title });
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

      firefoxFolderSelect.innerHTML = '<option value="">Select a folder...</option>';
      for (const folder of firefoxFolders) {
        const option = document.createElement('option');
        option.value = folder.id;
        option.textContent = folder.title || 'Unnamed Folder';
        firefoxFolderSelect.appendChild(option);
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

      raindropCollections.sort((a, b) => {
        if (a.parent && !b.parent) return 1;
        if (!a.parent && b.parent) return -1;
        return a.title.localeCompare(b.title);
      });

      raindropCollectionSelect.innerHTML = '<option value="">Select a collection...</option>';

      const createOption = document.createElement('option');
      createOption.value = 'new';
      createOption.textContent = '+ Create new collection';
      raindropCollectionSelect.appendChild(createOption);

      for (const collection of raindropCollections) {
        const option = document.createElement('option');
        option.value = collection._id.toString();
        option.textContent = collection.parent
          ? `  \u21B3 ${collection.title}`
          : collection.title;
        raindropCollectionSelect.appendChild(option);
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
  if (currentMappings.length === 0) {
    mappingsList.innerHTML = '<p class="empty-state">No mappings configured</p>';
    return;
  }

  mappingsList.innerHTML = currentMappings
    .map(
      (mapping) => `
      <div class="mapping-item" data-id="${mapping.id}">
        <div class="mapping-info">
          <div class="mapping-folder">
            <span class="mapping-icon">\uD83D\uDCC1</span>
            <span class="mapping-name">${escapeHtml(mapping.folderName)}</span>
            ${mapping.depth > 0 ? `<span class="mapping-depth">(depth: ${mapping.depth})</span>` : ''}
          </div>
          <span class="mapping-arrow">\u2192</span>
          <div class="mapping-collection">
            <span class="mapping-icon">\uD83C\uDF27\uFE0F</span>
            <span class="mapping-name">${escapeHtml(mapping.raindropCollectionName)}</span>
          </div>
        </div>
        <button class="remove-mapping-btn" data-id="${mapping.id}">Remove</button>
      </div>
    `
    )
    .join('');

  mappingsList.querySelectorAll('.remove-mapping-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const mappingId = (e.target as HTMLElement).dataset.id;
      if (mappingId && confirm('Remove this mapping?')) {
        await removeMapping(mappingId);
      }
    });
  });
}

// Render errors list
function renderErrors(errors: SyncError[]): void {
  if (errors.length === 0) {
    errorsList.innerHTML = '<p class="empty-state">No errors</p>';
    return;
  }

  errorsList.innerHTML = errors
    .slice(0, 10)
    .map(
      (error) => `
      <div class="error-item">
        <div class="error-time">${formatDate(error.timestamp)}</div>
        <div class="error-operation">${escapeHtml(error.operation)}</div>
        <div class="error-message">${escapeHtml(error.message)}</div>
      </div>
    `
    )
    .join('');
}

// Add mapping
async function addMapping(): Promise<void> {
  const firefoxFolderId = firefoxFolderSelect.value;
  const collectionValue = raindropCollectionSelect.value;
  const syncChildren = syncChildrenCheckbox.checked;

  if (!firefoxFolderId || !collectionValue) {
    alert('Please select both a Firefox folder and a Raindrop collection');
    return;
  }

  const folder = firefoxFolders.find((f) => f.id === firefoxFolderId);
  if (!folder) {
    alert('Selected folder not found');
    return;
  }

  let collectionId: number;
  let collectionName: string;

  if (collectionValue === 'new') {
    alert('Creating new collections is not yet implemented. Please select an existing collection.');
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
    syncChildren,
  };

  try {
    addMappingBtn.textContent = 'Adding...';
    addMappingBtn.disabled = true;

    const addResponse = await sendMessage('addFolderMapping', mapping);
    if (!addResponse.success) {
      throw new Error(addResponse.error || 'Failed to add folder mapping');
    }

    if (syncChildren) {
      const childrenResponse = await sendMessage('syncFolderWithChildren', {
        firefoxFolderId,
        raindropParentId: collectionId,
      });
      if (!childrenResponse.success) {
        console.warn('Failed to sync some subfolders:', childrenResponse.error);
      }
    }

    const syncResponse = await sendMessage('performInitialSync', mapping);
    if (!syncResponse.success) {
      throw new Error(syncResponse.error || 'Failed to perform initial sync');
    }

    const syncResult = syncResponse.data as { matched: number; createdInRaindrop: number; createdInFirefox: number; errors: string[] };

    if (syncResult.errors && syncResult.errors.length > 0) {
      alert(`Mapping added, but some bookmarks failed to sync:\n${syncResult.errors.join('\n')}`);
    } else {
      alert(`Mapping added and synced successfully!\nMatched: ${syncResult.matched}\nCreated in Raindrop: ${syncResult.createdInRaindrop}\nCreated in Firefox: ${syncResult.createdInFirefox}`);
    }

    await loadMappings();
    await loadStats();

    firefoxFolderSelect.value = '';
    raindropCollectionSelect.value = '';
    syncChildrenCheckbox.checked = true;
  } catch (error) {
    console.error('Failed to add mapping:', error);
    alert('Failed to add mapping. Please try again.');
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
    } else {
      alert('Failed to remove mapping: ' + (response.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Failed to remove mapping:', error);
    alert('Failed to remove mapping');
  }
}

// Update settings
async function updateSettingsAction(updates: Partial<SyncSettings>): Promise<void> {
  try {
    await sendMessage('updateSettings', updates);
  } catch (error) {
    console.error('Failed to update settings:', error);
    alert('Failed to save settings');
  }
}

// Setup event listeners
function setupEventListeners(): void {
  // Save token button
  saveTokenBtn.addEventListener('click', async () => {
    const token = apiTokenInput.value.trim();

    if (!token) {
      alert('Please enter your Test Token');
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

      alert(`Connected as ${user.fullName}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to connect';
      alert(msg);
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

  // Disconnect button
  disconnectBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect?')) {
      await sendMessage('logout');
      showDisconnectedState();
    }
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
    syncNowBtn.textContent = 'Syncing...';
    syncNowBtn.disabled = true;

    try {
      const response = await sendMessage('triggerSync');

      if (response.success) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await loadStats();
        alert('Sync completed successfully');
      } else {
        alert('Sync failed: ' + (response.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Sync error:', error);
      alert('Failed to trigger sync');
    } finally {
      syncNowBtn.textContent = 'Sync Now';
      syncNowBtn.disabled = false;
      await loadStats();
    }
  });

  fullResyncBtn.addEventListener('click', async () => {
    if (!confirm('This will resync all mapped folders. Continue?')) {
      return;
    }

    fullResyncBtn.textContent = 'Resyncing...';
    fullResyncBtn.disabled = true;

    try {
      const response = await sendMessage('performFullResync');
      if (response.success) {
        alert('Full resync completed successfully');
      } else {
        alert('Full resync failed: ' + response.error);
      }
      await loadStats();
    } catch (error) {
      alert('Failed to perform full resync');
    } finally {
      fullResyncBtn.textContent = 'Full Resync';
      fullResyncBtn.disabled = false;
    }
  });

  retryFailedBtn.addEventListener('click', async () => {
    await sendMessage('retryFailed');
    await loadStats();
  });

  clearErrorsBtn.addEventListener('click', async () => {
    await sendMessage('clearSyncErrors');
    await loadStats();
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
