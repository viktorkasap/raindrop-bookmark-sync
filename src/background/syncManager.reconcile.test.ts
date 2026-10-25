// Tests for the unified three-way reconcile engine (task 014).
// Boundary mocks mirror syncManager.test.ts: webextension-polyfill + raindropApi.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bookmarks } from 'webextension-polyfill';
import type { FolderMapping, BookmarkLink } from '../types/storage';
import type { Collection, Raindrop } from '../types/raindrop';
import { STORAGE_KEYS, DEFAULT_SYNC_SETTINGS } from '../types/storage';
import { computeBookmarkHash, computeRaindropHash } from '../utils/hash';

const { store, browserMock, api } = vi.hoisted(() => {
  const store: Record<string, unknown> = {};
  const browserMock = {
    runtime: { getBrowserInfo: undefined as (() => Promise<{ name: string }>) | undefined },
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
      },
    },
    bookmarks: {
      get: vi.fn(async (id: string) => [{ id, title: 'x' }]),
      getChildren: vi.fn(
        async (
          _id: string
        ): Promise<{ id: string; title: string; parentId?: string; url?: string }[]> => []
      ),
      create: vi.fn(),
      update: vi.fn(),
      move: vi.fn(),
      remove: vi.fn(async (_id: string) => {}),
      removeTree: vi.fn(async () => {}),
    },
    alarms: {
      get: vi.fn(async () => undefined),
      create: vi.fn(),
      clear: vi.fn(),
    },
  };
  const api = {
    getAllCollections: vi.fn(),
    getAllRaindropsInCollection: vi.fn(),
    createRaindrop: vi.fn(),
    createRaindrops: vi.fn(),
    createCollection: vi.fn(),
    updateCollection: vi.fn(),
    updateRaindrop: vi.fn(),
    deleteRaindrop: vi.fn(),
    deleteCollection: vi.fn(),
    getCollection: vi.fn(),
    getCurrentUser: vi.fn(),
  };
  return { store, browserMock, api };
});

vi.mock('webextension-polyfill', () => ({ default: browserMock }));
vi.mock('./raindropApi', () => api);

import { reconcileAllMappings, performFullResync } from './syncManager';

// ---- Fixtures ----

function collection(partial: Partial<Collection> & { _id: number }): Collection {
  return { title: `c${partial._id}`, parent: null, ...partial } as Collection;
}

function raindrop(
  partial: Partial<Raindrop> & { _id: number; link: string; title: string }
): Raindrop {
  return { collection: { $id: 42 }, ...partial } as unknown as Raindrop;
}

const mapping: FolderMapping = {
  id: 'm1',
  firefoxFolderId: 'ff-folder-1',
  raindropCollectionId: 42,
  folderName: 'Work',
  raindropCollectionName: 'Work',
  depth: 0,
  lastSync: 0,
};

const syncedHash = computeBookmarkHash('https://example.com/', 'Example');

const link: BookmarkLink = {
  id: 'l1',
  firefoxId: 'ff-bm-1',
  raindropId: 7,
  url: 'https://example.com/',
  title: 'Example',
  lastModified: 0,
  contentHash: syncedHash,
  syncStatus: 'synced',
  mappingId: 'm1',
};

const browserBookmark = {
  id: 'ff-bm-1',
  title: 'Example',
  url: 'https://example.com/',
  parentId: 'ff-folder-1',
};

function seedStorage(): void {
  store[STORAGE_KEYS.SYNC_SETTINGS] = { ...DEFAULT_SYNC_SETTINGS, enabled: true };
  store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
  store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
}

beforeEach(() => {
  vi.resetAllMocks();
  browserMock.storage.local.get.mockImplementation(async (key: string) =>
    key in store ? { [key]: store[key] } : {}
  );
  browserMock.storage.local.set.mockImplementation(
    async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }
  );
  browserMock.storage.local.remove.mockImplementation(async (key: string) => {
    delete store[key];
  });
  browserMock.bookmarks.get.mockImplementation(async (id: string) => [
    { id, title: 'x' },
  ]);
  browserMock.bookmarks.getChildren.mockResolvedValue([]);
  browserMock.bookmarks.remove.mockResolvedValue(undefined);
  browserMock.bookmarks.removeTree.mockResolvedValue(undefined);

  for (const key of Object.keys(store)) delete store[key];
  seedStorage();
});

// ---- Steps 2-4: linked-bookmark direction ----

describe('reconcileAllMappings — direction per linked bookmark', () => {
  it('pushes a browser-side edit to Raindrop (raindrop unchanged)', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([
      { ...browserBookmark, title: 'Example v2' },
    ]);

    const result = await reconcileAllMappings();

    expect(api.updateRaindrop).toHaveBeenCalledWith(7, {
      link: 'https://example.com/',
      title: 'Example v2',
    });
    expect(result.pushed).toBe(1);
    expect(browserMock.bookmarks.update).not.toHaveBeenCalled();
    const links = store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[];
    expect(links[0].contentHash).toBe(
      computeBookmarkHash('https://example.com/', 'Example v2')
    );
    expect(links[0].title).toBe('Example v2');
  });

  it('pulls a Raindrop-side edit into the browser (browser unchanged)', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Example v9' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([browserBookmark]);

    const result = await reconcileAllMappings();

    expect(browserMock.bookmarks.update).toHaveBeenCalledWith('ff-bm-1', {
      title: 'Example v9',
      url: 'https://example.com/',
    });
    expect(api.updateRaindrop).not.toHaveBeenCalled();
    expect(result.pulled).toBe(1);
    const links = store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[];
    expect(links[0].contentHash).toBe(
      computeRaindropHash('https://example.com/', 'Example v9')
    );
  });

  it('both sides changed → conflict → Raindrop wins', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Raindrop title' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([
      { ...browserBookmark, title: 'Browser title' },
    ]);

    const result = await reconcileAllMappings();

    expect(browserMock.bookmarks.update).toHaveBeenCalledWith('ff-bm-1', {
      title: 'Raindrop title',
      url: 'https://example.com/',
    });
    expect(api.updateRaindrop).not.toHaveBeenCalled();
    expect(result.pulled).toBe(1);
    expect(result.pushed).toBe(0);
  });
});

// ---- Step 5: deletion propagation (baseline required by construction) ----

describe('reconcileAllMappings — deletions', () => {
  it('deleted in browser + raindrop untouched → deletes the raindrop and the link', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([]);
    browserMock.bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'ff-bm-1') throw new Error('Bookmark not found');
      return [{ id, title: 'x' }];
    });

    // A working create mock would EXPOSE resurrection: the raindrop deleted in
    // phase 1 is still in the (stale) phase-3 snapshot and must not come back.
    browserMock.bookmarks.create.mockResolvedValue({
      id: 'ff-resurrected',
      title: 'Example',
      url: 'https://example.com/',
    });

    const result = await reconcileAllMappings();

    expect(api.deleteRaindrop).toHaveBeenCalledWith(7);
    expect(result.deletedInRaindrop).toBe(1);
    expect(store[STORAGE_KEYS.BOOKMARK_LINKS]).toEqual([]);
    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });

  it('deleted in Raindrop + browser untouched → removes the browser bookmark and the link', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([]);
    browserMock.bookmarks.getChildren.mockResolvedValue([browserBookmark]);

    // Symmetric resurrection guard: the bookmark deleted in phase 1 is still
    // in the (stale) phase-2 browser snapshot and must not be pushed back.
    api.createRaindrops.mockResolvedValue([
      raindrop({ _id: 999, link: 'https://example.com/', title: 'Example' }),
    ]);

    const result = await reconcileAllMappings();

    expect(browserMock.bookmarks.remove).toHaveBeenCalledWith('ff-bm-1');
    expect(api.deleteRaindrop).not.toHaveBeenCalled();
    expect(result.deletedInBrowser).toBe(1);
    expect(store[STORAGE_KEYS.BOOKMARK_LINKS]).toEqual([]);
    expect(api.createRaindrops).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });

  it('deleted in browser + EDITED in Raindrop → Raindrop wins → resurrects the bookmark', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Edited remotely' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([]);
    browserMock.bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'ff-bm-1') throw new Error('Bookmark not found');
      return [{ id, title: 'x' }];
    });
    browserMock.bookmarks.create.mockResolvedValue({
      id: 'ff-bm-new',
      title: 'Edited remotely',
      url: 'https://example.com/',
    });

    const result = await reconcileAllMappings();

    expect(browserMock.bookmarks.create).toHaveBeenCalledWith({
      parentId: 'ff-folder-1',
      title: 'Edited remotely',
      url: 'https://example.com/',
    });
    expect(api.deleteRaindrop).not.toHaveBeenCalled();
    expect(result.pulled).toBe(1);
    const links = store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[];
    expect(links).toHaveLength(1);
    expect(links[0].firefoxId).toBe('ff-bm-new');
    expect(links[0].raindropId).toBe(7);
  });
});

// ---- Step 7: no baseline → union/merge, never delete ----

describe('reconcileAllMappings — union without baseline', () => {
  it('unlinked items on both sides → creates on the opposite side, deletes nothing', async () => {
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [];
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 8, link: 'https://only-raindrop.com/', title: 'R-only' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([
      { id: 'ff-bm-2', title: 'B-only', url: 'https://only-browser.com/', parentId: 'ff-folder-1' },
    ]);
    api.createRaindrops.mockResolvedValue([
      raindrop({ _id: 100, link: 'https://only-browser.com/', title: 'B-only' }),
    ]);
    browserMock.bookmarks.create.mockResolvedValue({
      id: 'ff-bm-3',
      title: 'R-only',
      url: 'https://only-raindrop.com/',
    });

    const result = await reconcileAllMappings();

    expect(api.createRaindrops).toHaveBeenCalledTimes(1);
    expect(browserMock.bookmarks.create).toHaveBeenCalledWith({
      parentId: 'ff-folder-1',
      title: 'R-only',
      url: 'https://only-raindrop.com/',
    });
    expect(api.deleteRaindrop).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.remove).not.toHaveBeenCalled();
    expect(result.createdInRaindrop).toBe(1);
    expect(result.createdInBrowser).toBe(1);
    const links = store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[];
    expect(links).toHaveLength(2);
  });

  it('same URL on both sides → adopts (links them, Raindrop wins content)', async () => {
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [];
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 9, link: 'https://example.com/', title: 'Raindrop title' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([
      { id: 'ff-bm-4', title: 'Browser title', url: 'https://example.com/', parentId: 'ff-folder-1' },
    ]);

    const result = await reconcileAllMappings();

    expect(result.adopted).toBe(1);
    expect(api.createRaindrops).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.update).toHaveBeenCalledWith('ff-bm-4', {
      title: 'Raindrop title',
      url: 'https://example.com/',
    });
    const links = store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[];
    expect(links).toHaveLength(1);
    expect(links[0].firefoxId).toBe('ff-bm-4');
    expect(links[0].raindropId).toBe(9);
  });
});

// ---- Steps 8-9: cross-mapping moves ----

const mapping2: FolderMapping = {
  id: 'm2',
  firefoxFolderId: 'ff-folder-2',
  raindropCollectionId: 43,
  folderName: 'Play',
  raindropCollectionName: 'Play',
  depth: 0,
  lastSync: 0,
};

describe('reconcileAllMappings — cross-mapping moves', () => {
  beforeEach(() => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, mapping2];
    api.getAllCollections.mockResolvedValue([
      collection({ _id: 42 }),
      collection({ _id: 43 }),
    ]);
  });

  it('bookmark moved to another mapped folder → raindrop moves collection, same _id', async () => {
    api.getAllRaindropsInCollection.mockImplementation(async (id: number) =>
      id === 42 ? [raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' })] : []
    );
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-2' ? [{ ...browserBookmark, parentId: 'ff-folder-2' }] : []
    );

    const result = await reconcileAllMappings();

    expect(api.updateRaindrop).toHaveBeenCalledWith(7, {
      link: 'https://example.com/',
      title: 'Example',
      collection: { $id: 43 },
    });
    expect(api.deleteRaindrop).not.toHaveBeenCalled();
    expect(api.createRaindrops).not.toHaveBeenCalled();
    expect(result.pushed).toBe(1);
    const links = store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[];
    expect(links[0].mappingId).toBe('m2');
    expect(links[0].raindropId).toBe(7);
  });

  it('raindrop moved to another mapped collection → browser bookmark moves folder (NEW: old pull deleted it)', async () => {
    api.getAllRaindropsInCollection.mockImplementation(async (id: number) =>
      id === 43 ? [raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' })] : []
    );
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1' ? [browserBookmark] : []
    );

    const result = await reconcileAllMappings();

    expect(browserMock.bookmarks.move).toHaveBeenCalledWith('ff-bm-1', {
      parentId: 'ff-folder-2',
    });
    expect(browserMock.bookmarks.remove).not.toHaveBeenCalled();
    expect(result.pulled).toBe(1);
    const links = store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[];
    expect(links[0].mappingId).toBe('m2');
  });

  it('both sides already in the target mapping → link re-pointed without API calls', async () => {
    // e.g. the previous pass moved the raindrop but the link update was lost
    // (SW died). Raindrop and bookmark agree; only the baseline is stale.
    api.getAllRaindropsInCollection.mockImplementation(async (id: number) =>
      id === 43 ? [raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' })] : []
    );
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-2' ? [{ ...browserBookmark, parentId: 'ff-folder-2' }] : []
    );

    await reconcileAllMappings();

    expect(api.updateRaindrop).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.move).not.toHaveBeenCalled();
    const links = store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[];
    expect(links[0].mappingId).toBe('m2');
    expect(links[0].raindropId).toBe(7);
  });
});

// ---- Step 10: deletion-safety guards (fail-closed) ----

describe('reconcileAllMappings — deletion-safety guards', () => {
  it('collection missing from cache (incomplete list) → mapping untouched', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 99 })]);
    api.getCollection.mockResolvedValue(collection({ _id: 42 })); // direct fetch: exists → cache incomplete
    browserMock.bookmarks.getChildren.mockResolvedValue([]);

    const result = await reconcileAllMappings();

    expect(api.deleteRaindrop).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.remove).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.removeTree).not.toHaveBeenCalled();
    expect((store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[])).toHaveLength(1);
    expect(result.deletedInRaindrop + result.deletedInBrowser).toBe(0);
  });

  it('raindrop fetch fails for a mapping → its links untouched', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockRejectedValue(new Error('network'));
    browserMock.bookmarks.getChildren.mockResolvedValue([]);

    const result = await reconcileAllMappings();

    expect(api.deleteRaindrop).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.remove).not.toHaveBeenCalled();
    expect((store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[])).toHaveLength(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('persists a failed-mapping error with a type + message (task 015)', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockRejectedValue(new Error('network'));
    browserMock.bookmarks.getChildren.mockResolvedValue([]);

    await reconcileAllMappings();

    const stored = store[STORAGE_KEYS.SYNC_ERRORS] as
      | { type: string; message: string }[]
      | undefined;
    expect(stored).toBeDefined();
    expect(stored!.some((e) => e.type === 'fetch' && /network/.test(e.message))).toBe(true);
  });

  it('clears persisted errors on a clean pass (replace-all → []) (task 015)', async () => {
    // Seed a stale error from a previous pass.
    store[STORAGE_KEYS.SYNC_ERRORS] = [{ type: 'fetch', message: 'old' }];
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([browserBookmark]);

    const result = await reconcileAllMappings();

    expect(result.errors).toEqual([]);
    expect(store[STORAGE_KEYS.SYNC_ERRORS]).toEqual([]);
  });

  it('bookmark absent but existence check fails with a NON-not-found error → link kept (fail-closed)', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([]);
    browserMock.bookmarks.get.mockImplementation(async (id: string) => {
      // Contains "not found" but is NOT a bookmark-not-found → must fail closed.
      if (id === 'ff-bm-1') throw new Error('Bookmarks database not found');
      return [{ id, title: 'x' }];
    });

    const result = await reconcileAllMappings();

    expect(api.deleteRaindrop).not.toHaveBeenCalled();
    expect((store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[])).toHaveLength(1);
    expect(result.deletedInRaindrop).toBe(0);
  });

  it('unlinked raindrop whose URL is already linked elsewhere → no duplicate bookmark', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, mapping2];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [
      {
        ...link,
        id: 'l2',
        firefoxId: 'ff-bm-9',
        raindropId: 20,
        mappingId: 'm2',
        contentHash: syncedHash,
      },
    ];
    api.getAllCollections.mockResolvedValue([
      collection({ _id: 42 }),
      collection({ _id: 43 }),
    ]);
    api.getAllRaindropsInCollection.mockImplementation(async (id: number) => {
      if (id === 42) {
        // duplicate raindrop: same URL as the l2 link, different _id, unlinked
        return [raindrop({ _id: 21, link: 'https://example.com/', title: 'Example' })];
      }
      return [raindrop({ _id: 20, link: 'https://example.com/', title: 'Example' })];
    });
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-2'
        ? [{ ...browserBookmark, id: 'ff-bm-9', parentId: 'ff-folder-2' }]
        : []
    );

    const result = await reconcileAllMappings();

    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    expect(result.createdInBrowser).toBe(0);
    expect((store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[])).toHaveLength(1);
  });
});

// ---- Step 11: idempotency + lock ----

describe('reconcileAllMappings — idempotency and lock', () => {
  it('second pass after a push performs zero writes (loop extinguishes)', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([
      { ...browserBookmark, title: 'Example v2' },
    ]);

    const first = await reconcileAllMappings();
    expect(first.pushed).toBe(1);

    // Second pass sees the post-push Raindrop state; browser unchanged.
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Example v2' }),
    ]);
    api.updateRaindrop.mockClear();
    browserMock.bookmarks.update.mockClear();
    browserMock.bookmarks.create.mockClear();

    const second = await reconcileAllMappings();

    expect(second.pushed + second.pulled).toBe(0);
    expect(api.updateRaindrop).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.update).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
  });

  it('fresh reconcile lock held → returns immediately without touching anything', async () => {
    store['reconcile_lock'] = { timestamp: Date.now() };

    const result = await reconcileAllMappings();

    expect(api.getAllCollections).not.toHaveBeenCalled();
    expect(result.pushed + result.pulled + result.deletedInRaindrop + result.deletedInBrowser).toBe(0);
  });
});

describe.each(['chrome', 'firefox'] as const)('bidirectional order with %s/API boundaries', (platform) => {
  let children: Record<string, Bookmarks.BookmarkTreeNode[]>;
  let drops: Record<number, Raindrop[]>;
  let collections: Collection[];
  let nextId: number;
  const root = 'ff-folder-1';
  const rootMapping = (): FolderMapping => (store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[])[0];
  const browserIds = (parent = root): string[] => children[parent].map((n) => n.id);
  const remoteIds = (parent = 42): number[] => drops[parent].map((r) => r._id);
  const remoteFolders = (parent = 42): number[] => collections.filter((c) => c.parent?.$id === parent)
    .sort((a, b) => a.sort - b.sort).map((c) => c._id);
  const reorderBrowser = (ids: string[], parent = root): void => {
    children[parent] = ids.map((id) => children[parent].find((n) => n.id === id)!);
  };
  const reorderRemote = (ids: number[], parent = 42): void => {
    drops[parent] = ids.map((id) => drops[parent].find((r) => r._id === id)!);
  };
  const node = (id: number, parentId = root): Bookmarks.BookmarkTreeNode => ({
    id: `b${id}`, parentId, title: `Bookmark ${id}`, url: `https://example.com/${id}`,
  });
  const drop = (id: number, parent = 42): Raindrop => raindrop({
    _id: id, collection: { $id: parent }, title: `Bookmark ${id}`, link: `https://example.com/${id}`,
  });
  function addFolder(id: number, parentId = root, parentCollection = 42, parentMapping = 'm1'): void {
    children[parentId].push({ id: `f${id}`, title: `Folder ${id}`, parentId });
    children[`f${id}`] = [];
    drops[id] = [];
    collections.push(collection({ _id: id, title: `Folder ${id}`, parent: { $id: parentCollection }, sort: id - 50 }));
    (store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[]).push({
      ...mapping, id: `m${id}`, firefoxFolderId: `f${id}`, raindropCollectionId: id,
      folderName: `Folder ${id}`, raindropCollectionName: `Folder ${id}`,
      parentMappingId: parentMapping, depth: parentId === root ? 1 : 2,
    });
  }

  beforeEach(() => {
    browserMock.runtime.getBrowserInfo = platform === 'firefox' ? async () => ({ name: 'Firefox' }) : undefined;
    nextId = 100;
    children = { [root]: [1, 2, 3].map((id) => node(id)) };
    drops = { 42: [1, 2, 3].map((id) => drop(id)) };
    collections = [collection({ _id: 42, title: 'Work', sort: 1 })];
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [{ ...mapping, bookmarkOrder: { baseline: [1, 2, 3] } }];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [1, 2, 3].map((id): BookmarkLink => ({
      ...link, id: `l${id}`, firefoxId: `b${id}`, raindropId: id,
      title: `Bookmark ${id}`, url: `https://example.com/${id}`,
      contentHash: computeBookmarkHash(`https://example.com/${id}`, `Bookmark ${id}`),
    }));
    browserMock.bookmarks.get.mockImplementation(async (id) => {
      if (id === root) return [{ id, title: 'Work' }];
      const found = Object.values(children).flat().find((n) => n.id === id);
      if (!found) throw new Error('Bookmark not found');
      return [structuredClone(found)];
    });
    browserMock.bookmarks.getChildren.mockImplementation(async (id) =>
      children[id].map((n, index) => ({ ...n, index })));
    browserMock.bookmarks.move.mockImplementation(async (id, destination) => {
      const source = Object.values(children).find((items) => items.some((n) => n.id === id))!;
      const oldIndex = source.findIndex((n) => n.id === id);
      const parentId = destination.parentId ?? source[oldIndex].parentId!;
      const target = children[parentId];
      let index = destination.index ?? target.length;
      if (platform === 'chrome' && source === target && index > oldIndex) index--;
      const [moved] = source.splice(oldIndex, 1);
      moved.parentId = parentId;
      target.splice(index, 0, moved);
      return { ...structuredClone(moved), index: target.indexOf(moved) };
    });
    browserMock.bookmarks.update.mockImplementation(async (id, updates) => {
      const found = Object.values(children).flat().find((n) => n.id === id)!;
      Object.assign(found, updates);
      return structuredClone(found);
    });
    browserMock.bookmarks.create.mockImplementation(async (data) => {
      const created = { id: `new${nextId++}`, ...data };
      children[data.parentId].push(created);
      if (!data.url) children[created.id] = [];
      return structuredClone(created);
    });
    browserMock.bookmarks.remove.mockImplementation(async (id) => {
      const parent = Object.values(children).find((items) => items.some((n) => n.id === id))!;
      parent.splice(parent.findIndex((n) => n.id === id), 1);
    });
    api.getAllCollections.mockImplementation(async () => structuredClone(collections));
    api.getAllRaindropsInCollection.mockImplementation(async (id) => structuredClone(drops[id]));
    api.updateRaindrop.mockImplementation(async (id, updates) => {
      const source = Object.values(drops).find((items) => items.some((r) => r._id === id))!;
      const found = source.find((r) => r._id === id)!;
      if (updates.collection) {
        source.splice(source.indexOf(found), 1);
        drops[updates.collection.$id].push(found);
      }
      Object.assign(found, updates);
      if (updates.order !== undefined) {
        const items = drops[found.collection.$id];
        items.splice(items.indexOf(found), 1);
        items.splice(updates.order, 0, found);
      }
      return structuredClone(found);
    });
    api.deleteRaindrop.mockImplementation(async (id) => {
      const items = Object.values(drops).find((rows) => rows.some((r) => r._id === id))!;
      items.splice(items.findIndex((r) => r._id === id), 1);
    });
    api.createRaindrops.mockImplementation(async (items) => items.map((item: { collection: { $id: number } }) => {
      const created = { _id: nextId++, ...item } as Raindrop;
      drops[item.collection.$id].push(created);
      return structuredClone(created);
    }));
    api.updateCollection.mockImplementation(async (id, updates) => {
      const found = collections.find((c) => c._id === id)!;
      expect(updates).not.toHaveProperty('sort');
      if (updates.title !== undefined) found.title = updates.title;
      if (updates.order !== undefined) {
        expect(updates.parentId).toBe(found.parent?.$id);
        const siblings = collections.filter((c) => c.parent?.$id === updates.parentId)
          .sort((a, b) => a.sort - b.sort).filter((c) => c._id !== id);
        siblings.splice(updates.order, 0, found);
        siblings.forEach((c, index) => { c.sort = index; });
      }
      return structuredClone(found);
    });
    api.createCollection.mockImplementation(async (data) => {
      const created = collection({ _id: nextId++, sort: 0, ...data });
      collections.push(created);
      drops[created._id] = [];
      return structuredClone(created);
    });
  });

  it('pushes a browser drag and does no writes on the following pass', async () => {
    reorderBrowser(['b3', 'b1', 'b2']);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteIds()).toEqual([3, 1, 2]);
    expect(api.updateRaindrop).toHaveBeenCalledWith(3, { order: 0 });
    expect(rootMapping().bookmarkOrder).toEqual({ baseline: [3, 1, 2] });
    api.updateRaindrop.mockClear();
    browserMock.bookmarks.move.mockClear();
    await reconcileAllMappings();
    expect(api.updateRaindrop).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.move).not.toHaveBeenCalled();
  });

  it('pulls remote order and lets Raindrop win an order conflict', async () => {
    reorderRemote([2, 3, 1]);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserIds()).toEqual(['b2', 'b3', 'b1']);
    reorderBrowser(['b1', 'b2', 'b3']);
    reorderRemote([3, 2, 1]);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserIds()).toEqual(['b3', 'b2', 'b1']);
    expect(remoteIds()).toEqual([3, 2, 1]);
  });

  it('upgrades without a baseline and appends remote-only bookmarks in their order', async () => {
    delete rootMapping().bookmarkOrder;
    reorderBrowser(['b2', 'b1', 'b3']);
    drops[42].unshift(drop(5), drop(4));
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteIds()).toEqual([2, 1, 3, 5, 4]);
    expect(children[root].map((n) => n.title)).toEqual(['Bookmark 2', 'Bookmark 1', 'Bookmark 3', 'Bookmark 5', 'Bookmark 4']);
  });

  it('preserves an inserted bookmark position in either direction', async () => {
    children[root].splice(1, 0, node(4));
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(drops[42].map((r) => r.title)).toEqual(['Bookmark 1', 'Bookmark 4', 'Bookmark 2', 'Bookmark 3']);
    drops[42].splice(2, 0, drop(5));
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(children[root].map((n) => n.title)).toEqual(['Bookmark 1', 'Bookmark 4', 'Bookmark 5', 'Bookmark 2', 'Bookmark 3']);
  });

  it('does not treat index shifts from deletion as a content conflict', async () => {
    children[root].splice(1, 1);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteIds()).toEqual([1, 3]);
    expect(api.updateRaindrop).not.toHaveBeenCalled();
    expect(rootMapping().bookmarkOrder).toEqual({ baseline: [1, 3] });
  });

  it('keeps browser order independent of a remote title change', async () => {
    reorderBrowser(['b3', 'b1', 'b2']);
    drops[42][0].title = 'Remote title';
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteIds()).toEqual([3, 1, 2]);
    expect(children[root].find((n) => n.id === 'b1')!.title).toBe('Remote title');
  });

  it('preserves folder and unsupported-node slots when pulling bookmark order', async () => {
    addFolder(50);
    reorderBrowser(['b1', 'f50', 'b2', 'b3']);
    children[root].splice(3, 0, { id: 'unsupported', title: 'Internal', url: 'chrome://settings' });
    reorderRemote([3, 2, 1]);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserIds()).toEqual(['b3', 'f50', 'b2', 'unsupported', 'b1']);
    expect(browserMock.bookmarks.move.mock.calls.every(([id]) => id.startsWith('b'))).toBe(true);
  });

  it('sorts nested sibling folders both ways without moving bookmark slots', async () => {
    addFolder(50);
    addFolder(51);
    addFolder(52, 'f50', 50, 'm50');
    addFolder(53, 'f50', 50, 'm50');
    reorderBrowser(['b1', 'f51', 'b2', 'f50', 'b3']);
    reorderBrowser(['f53', 'f52'], 'f50');
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteFolders(42)).toEqual([51, 50]);
    expect(remoteFolders(50)).toEqual([53, 52]);
    collections.find((c) => c._id === 50)!.sort = -1;
    collections.find((c) => c._id === 52)!.sort = -1;
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserIds()).toEqual(['b1', 'f50', 'b2', 'f51', 'b3']);
    expect(browserIds('f50')).toEqual(['f52', 'f53']);
    api.updateCollection.mockClear();
    browserMock.bookmarks.move.mockClear();
    await reconcileAllMappings();
    expect(api.updateCollection).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.move).not.toHaveBeenCalled();
  });

  it('moves only a displaced collection by order and accepts server-renumbered siblings', async () => {
    for (const id of [50, 51, 52, 53]) addFolder(id);
    for (const c of collections.filter((c) => c.parent?.$id === 42)) c.sort = (c._id - 49) * 100;
    rootMapping().folderOrder = { version: 1, baseline: [50, 51, 52, 53] };
    reorderBrowser(['b1', 'f53', 'b2', 'f50', 'b3', 'f51', 'f52']);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(api.updateCollection.mock.calls).toEqual([[53, { parentId: 42, order: 0 }]]);
    expect(remoteFolders()).toEqual([53, 50, 51, 52]);
    expect(rootMapping().folderOrder).toEqual({ version: 1, baseline: [53, 50, 51, 52] });
    api.updateCollection.mockClear();
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(api.updateCollection).not.toHaveBeenCalled();
  });

  it('resumes the version-1 folder target left by the previous package', async () => {
    for (const id of [50, 51, 52]) addFolder(id);
    rootMapping().folderOrder = { version: 1, baseline: [50, 51, 52], pending: {
      order: [52, 51, 50],
      browserOrder: ['b1', 'b2', 'b3', 'f52', 'f51', 'f50'], raindropOrder: [52, 51, 50],
    } };
    reorderBrowser(['b1', 'b2', 'b3', 'f52', 'f51', 'f50']);
    store[STORAGE_KEYS.SYNC_ERRORS] = [{ type: 'folder', message: 'Raindrop order verification failed' }];
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteFolders()).toEqual([52, 51, 50]);
    expect(api.updateCollection.mock.calls).toEqual([
      [52, { parentId: 42, order: 0 }], [51, { parentId: 42, order: 1 }],
    ]);
    expect(rootMapping().folderOrder).toEqual({ version: 1, baseline: [52, 51, 50] });
    expect(store[STORAGE_KEYS.SYNC_ERRORS]).toEqual([]);
  });

  it('places a bookmark moved across mappings at its browser position', async () => {
    addFolder(50);
    children.f50 = [node(4, 'f50'), node(5, 'f50')];
    drops[50] = [drop(4, 50), drop(5, 50)];
    await reconcileAllMappings();
    await browserMock.bookmarks.move('b2', { parentId: 'f50', index: 1 });
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteIds()).toEqual([1, 3]);
    expect(remoteIds(50)).toEqual([4, 2, 5]);
  });

  it('retains a partial target across background restart instead of pulling its own partial writes', async () => {
    reorderBrowser(['b3', 'b2', 'b1']);
    const update = api.updateRaindrop.getMockImplementation()!;
    let calls = 0;
    api.updateRaindrop.mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Network unavailable');
      return update(...args);
    });
    expect((await reconcileAllMappings()).errors).toHaveLength(1);
    expect(remoteIds()).toEqual([3, 1, 2]);
    expect(rootMapping().bookmarkOrder).toEqual({ baseline: [1, 2, 3], pending: {
      order: [3, 2, 1], browserOrder: ['b3', 'b2', 'b1'], raindropOrder: [3, 2, 1],
    } });
    expect((store[STORAGE_KEYS.SYNC_STATS] as { lastSyncStatus: string }).lastSyncStatus).toBe('partial');
    api.updateRaindrop.mockImplementation(update);
    vi.resetModules();
    const restarted = await import('./syncManager');
    expect((await restarted.reconcileAllMappings()).errors).toEqual([]);
    expect(remoteIds()).toEqual([3, 2, 1]);
    expect(browserIds()).toEqual(['b3', 'b2', 'b1']);
    expect(rootMapping().bookmarkOrder).toEqual({ baseline: [3, 2, 1] });
  });

  it('restores mixed-node slots after a browser move fails halfway', async () => {
    addFolder(50);
    reorderBrowser(['b1', 'f50', 'b2', 'b3']);
    reorderRemote([3, 2, 1]);
    const move = browserMock.bookmarks.move.getMockImplementation()!;
    let calls = 0;
    browserMock.bookmarks.move.mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Browser write failed');
      return move(...args);
    });
    expect((await reconcileAllMappings()).errors).toHaveLength(1);
    expect(browserIds()).toEqual(['b3', 'b1', 'f50', 'b2']);
    expect(rootMapping().bookmarkOrder?.pending?.browserOrder).toEqual(['b3', 'f50', 'b2', 'b1']);
    browserMock.bookmarks.move.mockImplementation(move);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserIds()).toEqual(['b3', 'f50', 'b2', 'b1']);
  });

  it('continues a partial collection reorder from its saved target', async () => {
    addFolder(50);
    addFolder(51);
    addFolder(52);
    rootMapping().folderOrder = { version: 1, baseline: [50, 51, 52] };
    reorderBrowser(['b1', 'f52', 'b2', 'f51', 'b3', 'f50']);
    const update = api.updateCollection.getMockImplementation()!;
    let calls = 0;
    api.updateCollection.mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Collection update failed');
      return update(...args);
    });
    expect((await reconcileAllMappings()).errors).toHaveLength(1);
    expect(rootMapping().folderOrder?.pending?.order).toEqual([52, 51, 50]);
    api.updateCollection.mockImplementation(update);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteFolders()).toEqual([52, 51, 50]);
    expect(rootMapping().folderOrder).toEqual({ version: 1, baseline: [52, 51, 50] });
  });

  it('restores a pending mixed layout even when deletions leave one bookmark', async () => {
    addFolder(50);
    reorderBrowser(['b1', 'f50', 'b2', 'b3']);
    reorderRemote([3, 2, 1]);
    const move = browserMock.bookmarks.move.getMockImplementation()!;
    let calls = 0;
    browserMock.bookmarks.move.mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Browser write failed');
      return move(...args);
    });
    await reconcileAllMappings();
    children[root] = children[root].filter((n) => n.id !== 'b3' && n.id !== 'b2');
    expect(browserIds()).toEqual(['b1', 'f50']);
    browserMock.bookmarks.move.mockImplementation(move);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserIds()).toEqual(['f50', 'b1']);
    expect(remoteIds()).toEqual([1]);
    expect(rootMapping().bookmarkOrder).toEqual({ baseline: [1] });
  });

  it('appends remote-only folders in manual order on first mapping', async () => {
    addFolder(50);
    collections.push(
      collection({ _id: 51, title: 'Remote A', parent: { $id: 42 }, sort: 1 }),
      collection({ _id: 52, title: 'Remote B', parent: { $id: 42 }, sort: 2 }),
    );
    drops[51] = [];
    drops[52] = [];
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(children[root].filter((n) => !n.url).map((n) => n.title)).toEqual(['Folder 50', 'Remote A', 'Remote B']);
    expect(rootMapping().folderOrder).toEqual({ version: 1, baseline: [50, 51, 52] });
  });

  it('places a bookmark moved from Raindrop at its remote position', async () => {
    addFolder(50);
    children.f50 = [node(4, 'f50'), node(5, 'f50')];
    drops[50] = [drop(4, 50), drop(5, 50)];
    await reconcileAllMappings();
    await api.updateRaindrop(2, { collection: { $id: 50 }, order: 1 });
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserIds().filter((id) => id.startsWith('b'))).toEqual(['b1', 'b3']);
    expect(browserIds('f50')).toEqual(['b4', 'b2', 'b5']);
  });

  it('finishes the two-bookmark mixed layout instead of retrying a no-op forward move', async () => {
    children[root] = [node(1), node(2)];
    drops[42] = [drop(1), drop(2)];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = (store[STORAGE_KEYS.BOOKMARK_LINKS] as BookmarkLink[]).slice(0, 2);
    addFolder(50);
    reorderBrowser(['b1', 'f50', 'b2']);
    reorderRemote([2, 1]);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserIds()).toEqual(['b2', 'f50', 'b1']);
    expect(browserMock.bookmarks.move).toHaveBeenCalledWith('b1', { index: platform === 'chrome' ? 3 : 2 });
    browserMock.bookmarks.move.mockClear();
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(browserMock.bookmarks.move).not.toHaveBeenCalled();
  });

  it.each([false, true])('replaces legacy folder order with browser order (old pending=%s)', async (pending) => {
    for (const id of [50, 51, 52]) addFolder(id);
    rootMapping().folderOrder = {
      baseline: [50, 51, 52],
      ...(pending ? { pending: {
        order: [52, 51, 50], browserOrder: ['f52', 'f51', 'f50'], raindropOrder: [52, 51, 50],
      } } : {}),
    };
    for (const c of collections.filter((c) => c.parent?.$id === 42)) c.sort = 52 - c._id;
    const browserBefore = browserIds();
    const bookmarkState = structuredClone(rootMapping().bookmarkOrder);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(remoteFolders()).toEqual([50, 51, 52]);
    expect(browserIds()).toEqual(browserBefore);
    expect(rootMapping().folderOrder).toEqual({ version: 1, baseline: [50, 51, 52] });
    expect(rootMapping().bookmarkOrder).toEqual(bookmarkState);
    expect(api.updateRaindrop).not.toHaveBeenCalled();
    api.updateCollection.mockClear();
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(api.updateCollection).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.move).not.toHaveBeenCalled();
  });

  it('versions a migration target before writing and resumes it after restart', async () => {
    for (const id of [50, 51, 52]) addFolder(id);
    rootMapping().folderOrder = { baseline: [50, 51, 52] };
    for (const c of collections.filter((c) => c.parent?.$id === 42)) c.sort = 53 - c._id;
    const update = api.updateCollection.getMockImplementation()!;
    let calls = 0;
    api.updateCollection.mockImplementation(async (...args) => {
      expect(rootMapping().folderOrder).toMatchObject({ version: 1, pending: { order: [50, 51, 52] } });
      if (++calls === 2) throw new Error('Migration interrupted');
      return update(...args);
    });
    expect((await reconcileAllMappings()).errors).toHaveLength(1);
    api.updateCollection.mockImplementation(update);
    vi.resetModules();
    const restarted = await import('./syncManager');
    expect((await restarted.reconcileAllMappings()).errors).toEqual([]);
    expect(remoteFolders()).toEqual([50, 51, 52]);
    expect(rootMapping().folderOrder).toEqual({ version: 1, baseline: [50, 51, 52] });
  });

  it.each(['browser', 'raindrop', 'both'])('uses current sibling membership after a folder moves on %s', async (side) => {
    addFolder(50);
    addFolder(51);
    addFolder(52, 'f51', 51, 'm51');
    children.f50 = [node(4, 'f50')];
    drops[50] = [drop(4, 50)];
    expect((await reconcileAllMappings()).errors).toEqual([]);
    if (side !== 'raindrop') await browserMock.bookmarks.move('f50', { parentId: 'f51' });
    if (side !== 'browser') collections.find((c) => c._id === 50)!.parent = { $id: 51 };
    children.f50[0].title = 'Edited after moving folder';
    api.updateCollection.mockClear();
    for (let pass = 0; pass < 3; pass++) expect((await reconcileAllMappings()).errors).toEqual([]);
    expect((await performFullResync()).success).toBe(true);
    expect(drops[50][0].title).toBe('Edited after moving folder');
    const movedMapping = (store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[]).find((m) => m.id === 'm50')!;
    expect(movedMapping).toMatchObject({ parentMappingId: 'm1', depth: 1 });
    expect(rootMapping().folderOrder?.baseline).toEqual([51]);
    if (side === 'both') expect(browserIds('f51')).toEqual(['f50', 'f52']);
    expect(api.updateCollection).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.removeTree).not.toHaveBeenCalled();
    expect(api.deleteCollection).not.toHaveBeenCalled();
  });

  it('keeps independently mapped roots outside sibling ordering', async () => {
    for (const id of [50, 51, 52]) addFolder(id);
    const independent = (store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[]).find((m) => m.id === 'm51')!;
    independent.depth = 0;
    delete independent.parentMappingId;
    reorderBrowser(['b1', 'b2', 'b3', 'f52', 'f51', 'f50']);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(rootMapping().folderOrder?.baseline).toEqual([52, 50]);
    expect(remoteFolders()).toEqual([52, 51, 50]);
    expect(browserIds().indexOf('f51')).toBe(4);
    expect(browserMock.bookmarks.move.mock.calls.some(([id]) => id === 'f51')).toBe(false);
  });

  it('reports changed members before sorting without claiming to have saved a new target', async () => {
    reorderBrowser(['b3', 'b2', 'b1']);
    const read = api.getAllRaindropsInCollection.getMockImplementation()!;
    let calls = 0;
    api.getAllRaindropsInCollection.mockImplementation(async (id) => ++calls === 2
      ? structuredClone(drops[id].filter((r) => r._id !== 2)) : read(id));
    const result = await reconcileAllMappings();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('sorting skipped for this pass');
    expect(rootMapping().bookmarkOrder?.pending).toBeUndefined();
    expect(api.updateRaindrop).not.toHaveBeenCalled();
    api.getAllRaindropsInCollection.mockImplementation(read);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(store[STORAGE_KEYS.SYNC_ERRORS]).toEqual([]);
  });

  it.each(['browser', 'raindrop'])('names the side when %s order verification fails and clears errors on recovery', async (side) => {
    const write = side === 'browser' ? browserMock.bookmarks.move : api.updateRaindrop;
    const implementation = write.getMockImplementation()!;
    if (side === 'browser') reorderRemote([3, 2, 1]);
    else reorderBrowser(['b3', 'b2', 'b1']);
    write.mockResolvedValue(undefined);
    const result = await reconcileAllMappings();
    const name = side === 'raindrop' ? 'Raindrop' : platform === 'chrome' ? 'Chrome' : 'Firefox';
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(`${name} order verification failed`);
    expect(result.errors[0]).toContain('saved target will be retried on the next sync');
    expect(rootMapping().bookmarkOrder?.pending?.order).toEqual([3, 2, 1]);
    write.mockImplementation(implementation);
    expect((await reconcileAllMappings()).errors).toEqual([]);
    expect(rootMapping().bookmarkOrder?.pending).toBeUndefined();
    expect(store[STORAGE_KEYS.SYNC_ERRORS]).toEqual([]);
  });
});

// ---- Step 1: no-op pass ----

describe('reconcileAllMappings — no-op', () => {
  it('does nothing when both sides match the baseline', async () => {
    api.getAllCollections.mockResolvedValue([collection({ _id: 42 })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      raindrop({ _id: 7, link: 'https://example.com/', title: 'Example' }),
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([browserBookmark]);

    const result = await reconcileAllMappings();

    expect(result.errors).toEqual([]);
    expect(
      result.pushed +
        result.pulled +
        result.deletedInRaindrop +
        result.deletedInBrowser +
        result.createdInRaindrop +
        result.createdInBrowser +
        result.adopted
    ).toBe(0);
    expect(api.updateRaindrop).not.toHaveBeenCalled();
    expect(api.deleteRaindrop).not.toHaveBeenCalled();
    expect(api.createRaindrops).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.remove).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
  });
});
