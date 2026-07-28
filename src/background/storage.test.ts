import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STORAGE_KEYS } from '../types/storage';

// ---- Boundary mock: webextension-polyfill storage.local backed by a real object ----

const { store, browserMock } = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  const browserMock = {
    storage: {
      local: {
        get: vi.fn(async (key: string) =>
          key in store ? { [key]: store[key] } : {}
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
        clear: vi.fn(async () => {
          for (const k of Object.keys(store)) delete store[k];
        }),
      },
    },
  };
  return { store, browserMock };
});

vi.mock('webextension-polyfill', () => ({ default: browserMock }));

import {
  resetLocalState,
  disableAutoSyncIfNoMappings,
  getSyncErrors,
  setSyncErrors,
} from './storage';

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('sync errors (inline, task 015)', () => {
  it('round-trips entries and returns [] when unset', async () => {
    expect(await getSyncErrors()).toEqual([]);
    await setSyncErrors([
      { type: 'fetch', message: 'boom' },
      { type: 'connection', message: 'global failure' },
    ]);
    expect(await getSyncErrors()).toEqual([
      { type: 'fetch', message: 'boom' },
      { type: 'connection', message: 'global failure' },
    ]);
  });

  it('replaces the whole set on each write (no append)', async () => {
    await setSyncErrors([{ type: 'sync', message: 'first' }]);
    await setSyncErrors([{ type: 'create', message: 'second' }]);
    expect(await getSyncErrors()).toEqual([{ type: 'create', message: 'second' }]);
    await setSyncErrors([]);
    expect(await getSyncErrors()).toEqual([]);
  });

  it('caps stored entries at 50 (keeps the first 50)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ type: 'sync' as const, message: `e${i}` }));
    await setSyncErrors(many);
    const stored = await getSyncErrors();
    expect(stored).toHaveLength(50);
    expect(stored[0].message).toBe('e0');
    expect(stored[49].message).toBe('e49');
  });
});

describe('resetLocalState (disconnect = blank slate)', () => {
  it('removes ALL extension-owned local storage (token, mappings, links, settings, stats, transient lock)', async () => {
    // Seed a fully-configured extension state.
    store[STORAGE_KEYS.API_TOKEN] = { testToken: 'secret' };
    store[STORAGE_KEYS.SYNC_SETTINGS] = { enabled: true, syncInterval: 1 };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [{ id: 'm1' }];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [{ id: 'l1' }];
    store[STORAGE_KEYS.SYNC_STATS] = { totalSynced: 5 };
    store['reconcile_lock'] = { timestamp: 123 };

    await resetLocalState();

    // Blank slate: nothing extension-owned survives.
    expect(store).toEqual({});
  });
});

describe('disableAutoSyncIfNoMappings (no mappings => no sync)', () => {
  it('turns enabled off and reports true when there are zero mappings', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [];
    store[STORAGE_KEYS.SYNC_SETTINGS] = { enabled: true, syncInterval: 5, lastFullSync: 0, debugMode: false };

    const disabled = await disableAutoSyncIfNoMappings();

    expect(disabled).toBe(true);
    expect((store[STORAGE_KEYS.SYNC_SETTINGS] as { enabled: boolean }).enabled).toBe(false);
  });

  it('leaves enabled untouched and reports false when a mapping exists', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [{ id: 'm1' }];
    store[STORAGE_KEYS.SYNC_SETTINGS] = { enabled: true, syncInterval: 5, lastFullSync: 0, debugMode: false };

    const disabled = await disableAutoSyncIfNoMappings();

    expect(disabled).toBe(false);
    expect((store[STORAGE_KEYS.SYNC_SETTINGS] as { enabled: boolean }).enabled).toBe(true);
  });

  it('is a no-op (reports false) when zero mappings but sync is already off', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [];
    store[STORAGE_KEYS.SYNC_SETTINGS] = { enabled: false, syncInterval: 5, lastFullSync: 0, debugMode: false };

    const disabled = await disableAutoSyncIfNoMappings();

    expect(disabled).toBe(false);
    expect((store[STORAGE_KEYS.SYNC_SETTINGS] as { enabled: boolean }).enabled).toBe(false);
  });
});
