import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SYNC_SETTINGS, DEFAULT_SYNC_STATS, STORAGE_KEYS } from '../types/storage';
import type { FolderMapping, SyncSettings } from '../types/storage';
import type { MessageResponse } from '../types/messages';

const browser = vi.hoisted(() => ({
  runtime: { sendMessage: vi.fn(), getManifest: vi.fn() },
  storage: { onChanged: { addListener: vi.fn() } },
  bookmarks: {
    onCreated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() },
    onChanged: { addListener: vi.fn() }, onMoved: { addListener: vi.fn() },
  },
}));
vi.mock('webextension-polyfill', () => ({ default: browser }));

function element() {
  const listeners = new Map<string, () => unknown>();
  return {
    checked: false, disabled: false, value: '', textContent: '', innerHTML: '',
    dataset: {} as Record<string, string>,
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    addEventListener: (name: string, handler: () => unknown) => listeners.set(name, handler),
    fire: (name: string) => listeners.get(name)!(),
    querySelector: () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } }),
    querySelectorAll: () => [],
    appendChild: vi.fn(),
  };
}

const mapping: FolderMapping = {
  id: 'm1', firefoxFolderId: 'folder', raindropCollectionId: 1,
  folderName: 'Work', raindropCollectionName: 'Work', depth: 0, lastSync: 0,
};
let settings: SyncSettings;
let mappings: FolderMapping[];
let elements: Map<string, ReturnType<typeof element>>;
let initialize: () => Promise<void>;
const el = (id: string) => elements.get(id)!;

function respond({ action, data }: { action: string; data?: Partial<SyncSettings> }): MessageResponse {
  switch (action) {
    case 'isAuthenticated': return { success: true, data: true };
    case 'getUser': return { success: true, data: { fullName: 'Test User' } };
    case 'getSettings': return { success: true, data: { ...settings } };
    case 'getFolderMappings': return { success: true, data: [...mappings] };
    case 'getSyncStats': return { success: true, data: DEFAULT_SYNC_STATS };
    case 'getSyncErrors':
    case 'getFirefoxBookmarkTree':
    case 'getCollections': return { success: true, data: [] };
    case 'updateSettings':
      Object.assign(settings, data);
      return { success: true, data: { ...settings } };
    case 'logout':
      settings = { ...DEFAULT_SYNC_SETTINGS };
      mappings = [];
      return { success: true };
    default: throw new Error(`Unexpected message: ${action}`);
  }
}

async function openOptions(): Promise<void> {
  await import('./options');
  await initialize();
}

function storageChanged(...keys: string[]): void {
  const listener = browser.storage.onChanged.addListener.mock.calls[0][0];
  listener(Object.fromEntries(keys.map((key) => [key, {}])), 'local');
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  settings = { ...DEFAULT_SYNC_SETTINGS, enabled: true };
  mappings = [mapping];
  elements = new Map();
  browser.runtime.getManifest.mockReturnValue({ version: 'test' });
  browser.runtime.sendMessage.mockImplementation(async (message) => respond(message));
  vi.stubGlobal('document', {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, element());
      return el(id);
    },
    createElement: element,
    addEventListener: (_name: string, handler: () => Promise<void>) => { initialize = handler; },
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Options Enable Sync state', () => {
  it.each([true, false])('shows saved enabled=%s after mappings load', async (enabled) => {
    settings.enabled = enabled;
    await openOptions();
    expect(el('enable-sync').checked).toBe(enabled);
    expect(el('enable-sync').disabled).toBe(false);
  });

  it.each(['getSettings', 'getFolderMappings'])('renders correctly when %s resolves first', async (first) => {
    mappings = [];
    settings.enabled = false;
    await openOptions();
    mappings = [mapping];
    settings.enabled = true;
    const resolve = new Map<string, (value: MessageResponse) => void>();
    browser.runtime.sendMessage.mockImplementation(({ action }) => new Promise<MessageResponse>((done) => {
      resolve.set(action, done);
    }));
    storageChanged(STORAGE_KEYS.SYNC_SETTINGS, STORAGE_KEYS.FOLDER_MAPPINGS);
    await vi.advanceTimersByTimeAsync(300);
    resolve.get(first)!(respond({ action: first }));
    await vi.advanceTimersByTimeAsync(0);
    const second = first === 'getSettings' ? 'getFolderMappings' : 'getSettings';
    resolve.get(second)!(respond({ action: second }));
    await vi.advanceTimersByTimeAsync(0);
    expect(el('enable-sync').checked).toBe(true);
    expect(el('enable-sync').disabled).toBe(false);
  });

  it('refreshes after a popup changes settings while Options stays open', async () => {
    await openOptions();
    for (const enabled of [false, true]) {
      settings.enabled = enabled;
      storageChanged(STORAGE_KEYS.SYNC_SETTINGS);
      await vi.advanceTimersByTimeAsync(300);
      expect(el('enable-sync').checked).toBe(enabled);
    }
  });

  it('turns off and disables controls when the last mapping is removed', async () => {
    await openOptions();
    mappings = [];
    storageChanged(STORAGE_KEYS.FOLDER_MAPPINGS);
    await vi.advanceTimersByTimeAsync(300);
    expect(el('enable-sync').checked).toBe(false);
    expect(el('enable-sync').disabled).toBe(true);
  });

  it('clears the toggle after disconnect', async () => {
    await openOptions();
    el('disconnect-btn').fire('click');
    el('disconnect-btn').fire('click');
    await vi.advanceTimersByTimeAsync(0);
    expect(el('enable-sync').checked).toBe(false);
    expect(el('enable-sync').disabled).toBe(true);
    expect(settings.enabled).toBe(false);
  });

  it('reads saved settings after a successful toggle without relying on storage events', async () => {
    await openOptions();
    browser.runtime.sendMessage.mockClear();
    el('enable-sync').checked = false;
    el('enable-sync').fire('change');
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.enabled).toBe(false);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({ action: 'getSettings', data: undefined });
    storageChanged(STORAGE_KEYS.FOLDER_MAPPINGS);
    await vi.advanceTimersByTimeAsync(300);
    expect(el('enable-sync').checked).toBe(false);
  });

  it.each(['rejected response', 'transport error', 'backend normalization'])('shows stored value after %s', async (failure) => {
    settings.enabled = false;
    await openOptions();
    browser.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.action !== 'updateSettings') return respond(message);
      if (failure === 'transport error') throw new Error('Background unavailable');
      if (failure === 'rejected response') return { success: false, error: 'Cannot save' };
      return { success: true, data: { ...settings } };
    });
    el('enable-sync').checked = true;
    el('enable-sync').fire('change');
    await vi.advanceTimersByTimeAsync(0);
    expect(el('enable-sync').checked).toBe(false);
    if (failure !== 'backend normalization') {
      expect(el('sync-status-msg').textContent).toBe('Failed to save settings');
    }
  });
});
