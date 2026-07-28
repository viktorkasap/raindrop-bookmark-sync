// Tests for the unified three-way reconcile engine (task 014).
// Boundary mocks mirror syncManager.test.ts: webextension-polyfill + raindropApi.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FolderMapping, BookmarkLink } from '../types/storage';
import type { Collection, Raindrop } from '../types/raindrop';
import { STORAGE_KEYS, DEFAULT_SYNC_SETTINGS } from '../types/storage';
import { computeBookmarkHash, computeRaindropHash } from '../utils/hash';

const { store, browserMock, api } = vi.hoisted(() => {
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
      remove: vi.fn(async () => {}),
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

import { reconcileAllMappings } from './syncManager';

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
