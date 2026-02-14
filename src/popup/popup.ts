// Popup Script
import browser from 'webextension-polyfill';
import { SyncStatus, MessageResponse } from '../types/messages';

// Send message to background script
async function sendMessage(
  action: string,
  data?: unknown
): Promise<MessageResponse> {
  return browser.runtime.sendMessage({ action, data });
}

// DOM Elements
const notAuthenticatedSection = document.getElementById('not-authenticated')!;
const authenticatedSection = document.getElementById('authenticated')!;
const openSettingsBtn = document.getElementById('open-settings-btn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
const userNameEl = document.getElementById('user-name')!;
const syncStatusEl = document.getElementById('sync-status')!;
const mappingsCountEl = document.getElementById('mappings-count')!;
const linksCountEl = document.getElementById('links-count')!;
const pendingCountEl = document.getElementById('pending-count')!;
const lastSyncEl = document.getElementById('last-sync')!;
const syncToggle = document.getElementById('sync-toggle') as HTMLInputElement;
const syncNowBtn = document.getElementById('sync-now-btn') as HTMLButtonElement;
const optionsLink = document.getElementById('options-link')!;
const versionEl = document.getElementById('version')!;

// State
let isSyncing = false;

// Initialize popup
async function initialize(): Promise<void> {
  // Set version
  const manifest = browser.runtime.getManifest();
  versionEl.textContent = `v${manifest.version}`;

  // Check authentication and load status
  await updateUI();

  // Set up event listeners
  setupEventListeners();
}

// Update UI based on current state
async function updateUI(): Promise<void> {
  try {
    const response = await sendMessage('getSyncStatus');

    if (!response.success) {
      showNotAuthenticatedUI();
      return;
    }

    const status = response.data as SyncStatus;

    if (status.isAuthenticated) {
      showAuthenticatedUI(status);
    } else {
      showNotAuthenticatedUI();
    }
  } catch {
    showNotAuthenticatedUI();
  }
}

// Show not authenticated UI
function showNotAuthenticatedUI(): void {
  notAuthenticatedSection.classList.remove('hidden');
  authenticatedSection.classList.add('hidden');
}

// Show authenticated UI
function showAuthenticatedUI(status: SyncStatus): void {
  notAuthenticatedSection.classList.add('hidden');
  authenticatedSection.classList.remove('hidden');

  // Update user name
  userNameEl.textContent = status.userName || 'Connected';

  // Update sync status badge
  updateSyncStatusBadge(status);

  // Update counts
  mappingsCountEl.textContent = status.mappingsCount.toString();
  linksCountEl.textContent = status.linksCount.toString();
  pendingCountEl.textContent = status.pendingOperations.toString();

  // Update last sync time
  if (status.lastSyncTime > 0) {
    lastSyncEl.textContent = formatRelativeTime(status.lastSyncTime);
  } else {
    lastSyncEl.textContent = 'Never';
  }

  // Update toggle
  syncToggle.checked = status.isEnabled;
}

// Update sync status badge
function updateSyncStatusBadge(status: SyncStatus): void {
  syncStatusEl.classList.remove('enabled', 'disabled', 'syncing');

  if (status.isSyncing) {
    syncStatusEl.textContent = 'Syncing...';
    syncStatusEl.classList.add('syncing');
  } else if (status.isEnabled) {
    syncStatusEl.textContent = 'Enabled';
    syncStatusEl.classList.add('enabled');
  } else {
    syncStatusEl.textContent = 'Disabled';
    syncStatusEl.classList.add('disabled');
  }
}

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return 'Just now';
  } else if (minutes < 60) {
    return `${minutes} min ago`;
  } else if (hours < 24) {
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  } else {
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }
}

// Set up event listeners
function setupEventListeners(): void {
  // Open Settings button
  openSettingsBtn.addEventListener('click', () => {
    browser.runtime.openOptionsPage();
  });

  // Disconnect button
  disconnectBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect?')) {
      try {
        await sendMessage('logout');
        await updateUI();
      } catch {
        // Failed to disconnect — UI will reflect the state on next update
      }
    }
  });

  // Sync toggle
  syncToggle.addEventListener('change', async () => {
    try {
      const response = await sendMessage('updateSettings', {
        enabled: syncToggle.checked,
      });

      if (!response.success) {
        syncToggle.checked = !syncToggle.checked;
      }

      await updateUI();
    } catch {
      syncToggle.checked = !syncToggle.checked;
    }
  });

  // Sync now button
  syncNowBtn.addEventListener('click', async () => {
    if (isSyncing) return;

    isSyncing = true;
    syncNowBtn.textContent = 'Syncing...';
    syncNowBtn.disabled = true;

    try {
      await updateUI();

      const response = await sendMessage('triggerSync');

      if (!response.success) {
        // Sync failed — status will be visible in UI
      }
    } finally {
      isSyncing = false;
      syncNowBtn.textContent = 'Sync Now';
      syncNowBtn.disabled = false;
      await updateUI();
    }
  });

  // Options link
  optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initialize);
