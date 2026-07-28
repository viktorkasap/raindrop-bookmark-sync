import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FolderMapping, BookmarkLink } from '../types/storage';
import type { Collection } from '../types/raindrop';
import { STORAGE_KEYS, DEFAULT_SYNC_SETTINGS } from '../types/storage';

// ---- Boundary mocks: webextension-polyfill + raindropApi ----

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
    createRaindrops: vi.fn(),
    createCollection: vi.fn(),
    updateRaindrop: vi.fn(),
    updateCollection: vi.fn(),
    deleteRaindrop: vi.fn(),
    deleteCollection: vi.fn(),
    getCollection: vi.fn(),
    getCurrentUser: vi.fn(),
  };
  return { store, browserMock, api };
});

vi.mock('webextension-polyfill', () => ({ default: browserMock }));
vi.mock('./raindropApi', () => api);

import {
  performInitialSync,
  reconcileAllMappings,
  reconcileFolderTree,
  syncFolderWithChildren,
  handleSyncAlarm,
  propagateBrowserFolderDeletions,
  propagateRaindropCollectionDeletions,
} from './syncManager';

// ---- Fixtures ----

function collection(partial: Partial<Collection> & { _id: number }): Collection {
  return { title: `c${partial._id}`, parent: null, ...partial } as Collection;
}

// A Raindrop API 404 error as apiRequest throws it (error with a `.status`).
function notFound404(): Error {
  return Object.assign(new Error('API request failed: 404 Not Found'), {
    status: 404,
  });
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

const link: BookmarkLink = {
  id: 'l1',
  firefoxId: 'ff-bm-1',
  raindropId: 7,
  url: 'https://example.com/',
  title: 'Example',
  lastModified: 0,
  contentHash: 'hash',
  syncStatus: 'synced',
  mappingId: 'm1',
};

function seedStorage(): void {
  store[STORAGE_KEYS.SYNC_SETTINGS] = { ...DEFAULT_SYNC_SETTINGS, enabled: true };
  store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
  store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): implementations set inside a test
  // must not leak into the next one. Re-install the defaults afterwards.
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

// ---- Deletion-safety guard (task 001, step 3) ----

// ---- reconcileFolderTree (task 001, step 4) ----

describe('reconcileFolderTree', () => {
  it('materializes a raindrop-only child collection as a browser folder + child mapping', async () => {
    // Collection 42 (mapped, root) has child collection 43 "Projects";
    // browser folder has no subfolders yet.
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.create.mockResolvedValue({
      id: 'ff-folder-2',
      title: 'Projects',
    });

    const mappings = await reconcileFolderTree(mapping, cache);

    // Folder created in the browser under the mapped root folder
    expect(browserMock.bookmarks.create).toHaveBeenCalledWith({
      parentId: 'ff-folder-1',
      title: 'Projects',
    });

    // Child mapping persisted with correct lineage
    const child = mappings.find((m) => m.raindropCollectionId === 43);
    expect(child).toMatchObject({
      firefoxFolderId: 'ff-folder-2',
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
    });
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toContainEqual(child);

    // Returns the whole subtree including the mapping itself
    expect(mappings.map((m) => m.id)).toContain('m1');
    expect(mappings).toHaveLength(2);
  });
  it('is idempotent: an existing child mapping is reused, nothing is created', async () => {
    // Same tree as above but the child mapping already exists and the
    // browser folder is already there — a second reconcile run must not
    // create folders, collections, or duplicate mappings (decision #1:
    // existing mapping is authoritative).
    const childMapping: FolderMapping = {
      id: 'm2',
      firefoxFolderId: 'ff-folder-2',
      raindropCollectionId: 43,
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, childMapping];
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-folder-2', title: 'Projects', parentId: 'ff-folder-1' }]
        : []
    );

    const mappings = await reconcileFolderTree(mapping, cache);

    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    expect(api.createCollection).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toHaveLength(2);
    expect(mappings.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('creates a Raindrop collection for a browser-only subfolder', async () => {
    // Browser has subfolder "Notes" (Chrome-style node: no `type`);
    // Raindrop side has no matching child collection.
    const cache = [collection({ _id: 42, title: 'Work' })];
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [
            { id: 'ff-folder-3', title: 'Notes', parentId: 'ff-folder-1' },
            { id: 'ff-bm-1', title: 'Example', parentId: 'ff-folder-1', url: 'https://example.com/' },
          ]
        : []
    );
    api.createCollection.mockResolvedValue(
      collection({ _id: 44, title: 'Notes', parent: { $id: 42 } })
    );

    const mappings = await reconcileFolderTree(mapping, cache);

    expect(api.createCollection).toHaveBeenCalledWith({
      title: 'Notes',
      parent: { $id: 42 },
    });
    // Bookmarks must not spawn collections; folders must not spawn bookmarks
    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();

    const child = mappings.find((m) => m.firefoxFolderId === 'ff-folder-3');
    expect(child).toMatchObject({
      raindropCollectionId: 44,
      folderName: 'Notes',
      parentMappingId: 'm1',
      depth: 1,
    });
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toContainEqual(child);
    // New collection joins the cache so recursion/idempotency sees it
    expect(cache.map((c) => c._id)).toContain(44);
  });

  it('links an unmapped subfolder to an existing collection by name (ci + trim)', async () => {
    // Browser subfolder " projects " vs collection "Projects" — same name
    // after trim, case-insensitively. Must pair them with a new mapping
    // only: no new collection, no new folder.
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-folder-2', title: ' projects ', parentId: 'ff-folder-1' }]
        : []
    );

    const mappings = await reconcileFolderTree(mapping, cache);

    expect(api.createCollection).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();

    const child = mappings.find((m) => m.raindropCollectionId === 43);
    expect(child).toMatchObject({
      firefoxFolderId: 'ff-folder-2',
      parentMappingId: 'm1',
      depth: 1,
    });
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toHaveLength(2);
  });

  it('renames the browser folder when the mapped collection was renamed (Raindrop wins)', async () => {
    // Pair m2: folder "Projects" ↔ collection 43, renamed in Raindrop to
    // "Projects 2.0". Decision #4: align the folder to the collection.
    const childMapping: FolderMapping = {
      id: 'm2',
      firefoxFolderId: 'ff-folder-2',
      raindropCollectionId: 43,
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, childMapping];
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects 2.0', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-folder-2', title: 'Projects', parentId: 'ff-folder-1' }]
        : []
    );

    const mappings = await reconcileFolderTree(mapping, cache);

    expect(browserMock.bookmarks.update).toHaveBeenCalledWith('ff-folder-2', {
      title: 'Projects 2.0',
    });
    const updated = mappings.find((m) => m.id === 'm2');
    expect(updated).toMatchObject({
      folderName: 'Projects 2.0',
      raindropCollectionName: 'Projects 2.0',
    });
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toContainEqual(updated);
  });

  it('pushes a browser-side folder rename to Raindrop (collection unchanged) — 014 inc.3', async () => {
    // Baseline (mapping.folderName) = "Projects"; the user renamed the browser
    // folder to "Projects NEW"; the collection still has the baseline name →
    // three-way says the browser side changed → push the rename.
    const childMapping: FolderMapping = {
      id: 'm2',
      firefoxFolderId: 'ff-folder-2',
      raindropCollectionId: 43,
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, childMapping];
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-folder-2', title: 'Projects NEW', parentId: 'ff-folder-1' }]
        : []
    );

    const mappings = await reconcileFolderTree(mapping, cache);

    expect(api.updateCollection).toHaveBeenCalledWith(43, { title: 'Projects NEW' });
    expect(browserMock.bookmarks.update).not.toHaveBeenCalled();
    const updated = mappings.find((m) => m.id === 'm2');
    expect(updated).toMatchObject({
      folderName: 'Projects NEW',
      raindropCollectionName: 'Projects NEW',
    });
  });

  it('both sides renamed → conflict → Raindrop wins (browser follows, no API rename)', async () => {
    const childMapping: FolderMapping = {
      id: 'm2',
      firefoxFolderId: 'ff-folder-2',
      raindropCollectionId: 43,
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, childMapping];
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'R-name', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-folder-2', title: 'B-name', parentId: 'ff-folder-1' }]
        : []
    );

    const mappings = await reconcileFolderTree(mapping, cache);

    expect(browserMock.bookmarks.update).toHaveBeenCalledWith('ff-folder-2', {
      title: 'R-name',
    });
    expect(api.updateCollection).not.toHaveBeenCalled();
    expect(mappings.find((m) => m.id === 'm2')).toMatchObject({
      folderName: 'R-name',
      raindropCollectionName: 'R-name',
    });
  });

  it('leaves names alone when they differ only in case/whitespace (no churn)', async () => {
    const childMapping: FolderMapping = {
      id: 'm2',
      firefoxFolderId: 'ff-folder-2',
      raindropCollectionId: 43,
      folderName: 'projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, childMapping];
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-folder-2', title: 'projects', parentId: 'ff-folder-1' }]
        : []
    );

    await reconcileFolderTree(mapping, cache);

    expect(browserMock.bookmarks.update).not.toHaveBeenCalled();
  });

  it('does NOT resurrect a deleted browser folder (Direction A owns folder deletion)', async () => {
    // Pair m2: folder ff-folder-2 ↔ collection 43. The folder was deleted in
    // the browser; the collection lives on. Under the bidirectional deletion
    // model, propagateBrowserFolderDeletions (Direction A) runs BEFORE
    // reconcile and deletes the collection + drops the mapping — so reconcile
    // must NOT recreate the folder. Reaching here with a missing folder is an
    // inconsistent state; reconcile skips it safely instead of resurrecting.
    const childMapping: FolderMapping = {
      id: 'm2',
      firefoxFolderId: 'ff-folder-2',
      raindropCollectionId: 43,
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, childMapping];
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ];
    // Folder gone: not among the children AND bookmarks.get fails
    browserMock.bookmarks.getChildren.mockResolvedValue([]);
    browserMock.bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'ff-folder-2') throw new Error('Bookmark not found');
      return [{ id, title: 'x' }];
    });

    await reconcileFolderTree(mapping, cache);

    // No resurrection: no folder recreated, mapping left untouched for
    // Direction A to clean up.
    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    const stored = store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[];
    expect(stored).toHaveLength(2);
    expect(stored.find((m) => m.id === 'm2')).toMatchObject({
      firefoxFolderId: 'ff-folder-2',
    });
  });

  it('does NOT resurrect a deleted collection (Direction B owns collection deletion)', async () => {
    // Pair m2: folder ff-folder-2 ↔ collection 43. The collection was deleted
    // in Raindrop; the folder lives on. Under the bidirectional deletion
    // model, propagateRaindropCollectionDeletions (Direction B) runs BEFORE
    // reconcile and removes the browser folder + drops the mapping — so
    // reconcile must NOT recreate the collection.
    const childMapping: FolderMapping = {
      id: 'm2',
      firefoxFolderId: 'ff-folder-2',
      raindropCollectionId: 43,
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, childMapping];
    const cache = [collection({ _id: 42, title: 'Work' })]; // 43 gone
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-folder-2', title: 'Projects', parentId: 'ff-folder-1' }]
        : []
    );

    await reconcileFolderTree(mapping, cache);

    // No resurrection: no collection recreated, mapping's collection id kept.
    expect(api.createCollection).not.toHaveBeenCalled();
    const stored = store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[];
    expect(stored.find((m) => m.id === 'm2')).toMatchObject({
      raindropCollectionId: 43,
    });
  });

  it('does NOT resurrect a mapped folder that was merely moved elsewhere', async () => {
    // Pair m2: folder ff-folder-2 ↔ collection 43. The user moved the folder
    // out of the mapped parent — it is not among the parent's children but
    // still exists (bookmarks.get succeeds). Treating "not a direct child"
    // as "deleted" would create a duplicate folder and repoint the mapping,
    // orphaning the real folder with its bookmarks.
    const childMapping: FolderMapping = {
      id: 'm2',
      firefoxFolderId: 'ff-folder-2',
      raindropCollectionId: 43,
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      parentMappingId: 'm1',
      depth: 1,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, childMapping];
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.getChildren.mockResolvedValue([]); // moved away
    browserMock.bookmarks.get.mockImplementation(async (id: string) => [
      { id, title: 'Projects' }, // ...but alive elsewhere
    ]);

    await reconcileFolderTree(mapping, cache);

    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    const stored = store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[];
    expect(stored.find((m) => m.id === 'm2')).toMatchObject({
      firefoxFolderId: 'ff-folder-2',
    });
  });

  it('does NOT hijack an independent mapping of a child collection', async () => {
    // Collection 43 is a child of the mapped root 42, but the user mapped it
    // SEPARATELY (own root mapping m3, depth 0) to an unrelated folder.
    // Reconciling the parent tree must leave that mapping alone — not create
    // a folder under the parent and repoint m3 to it.
    const foreignMapping: FolderMapping = {
      id: 'm3',
      firefoxFolderId: 'ff-other',
      raindropCollectionId: 43,
      folderName: 'Projects',
      raindropCollectionName: 'Projects',
      depth: 0,
      lastSync: 0,
    };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping, foreignMapping];
    const cache = [
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ];
    browserMock.bookmarks.getChildren.mockResolvedValue([]);
    browserMock.bookmarks.get.mockImplementation(async (id: string) => [
      { id, title: 'Projects' },
    ]);

    await reconcileFolderTree(mapping, cache);

    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    const stored = store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[];
    expect(stored.find((m) => m.id === 'm3')).toMatchObject({
      firefoxFolderId: 'ff-other',
    });
  });

  it('skips reconciliation when the mapping\'s own collection is gone', async () => {
    // The ROOT mapping's collection was deleted in Raindrop (root
    // resurrection is out of scope for task 001). Reconciling anyway would
    // create child collections under a dead parent id — undefined API
    // behavior. Bail out and leave the tree untouched.
    const cache = [collection({ _id: 99, title: 'Other' })]; // 42 gone
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-folder-3', title: 'Notes', parentId: 'ff-folder-1' }]
        : []
    );

    const mappings = await reconcileFolderTree(mapping, cache);

    expect(api.createCollection).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    expect(mappings).toEqual([mapping]);
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toHaveLength(1);
  });

  it('recurses deep (cap raised to 20) and only truncates far past real trees', async () => {
    // Chain of 22 nested raindrop-only collections under the mapped root.
    // The safety ceiling is MAX_SYNC_DEPTH = 20 (Raindrop itself accepts far
    // deeper nesting; the cap only guards against runaway). So 20 levels
    // materialize, levels 21–22 are cut off, and nothing crashes.
    const cache = [collection({ _id: 42, title: 'Work' })];
    for (let i = 0; i < 22; i++) {
      cache.push(
        collection({ _id: 100 + i, title: `L${i}`, parent: { $id: i === 0 ? 42 : 99 + i } })
      );
    }
    let folderSeq = 0;
    browserMock.bookmarks.create.mockImplementation(
      async (data: { title: string }) => ({ id: `ff-new-${folderSeq++}`, title: data.title })
    );

    const mappings = await reconcileFolderTree(mapping, cache);

    // Root + 20 created levels; levels 21–22 cut off
    expect(mappings).toHaveLength(21);
    expect(browserMock.bookmarks.create).toHaveBeenCalledTimes(20);
  });
});

describe('reconcileAllMappings with nested folders (Raindrop-side wire)', () => {
  it('materializes a new child collection as a folder and pulls its raindrops', async () => {
    // Markus case: mapped root "Work" + child collection
    // "Projects" in Raindrop with one raindrop. A periodic pull must
    // create the subfolder, the child mapping, AND the bookmark inside.
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [{ ...mapping }];
    api.getAllCollections.mockResolvedValue([
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ]);
    api.getAllRaindropsInCollection.mockImplementation(async (id: number) =>
      id === 43
        ? [{ _id: 10, link: 'https://nested.example.com/', title: 'Nested' }]
        : []
    );
    let seq = 0;
    browserMock.bookmarks.create.mockImplementation(
      async (data: { parentId: string; title: string; url?: string }) => ({
        id: `ff-new-${seq++}`,
        ...data,
      })
    );

    const result = await reconcileAllMappings();

    // Subfolder materialized under the root folder
    expect(browserMock.bookmarks.create).toHaveBeenCalledWith({
      parentId: 'ff-folder-1',
      title: 'Projects',
    });
    // Bookmark pulled into the new subfolder (ff-new-0 = the folder)
    expect(browserMock.bookmarks.create).toHaveBeenCalledWith({
      parentId: 'ff-new-0',
      title: 'Nested',
      url: 'https://nested.example.com/',
    });
    expect(result.createdInBrowser).toBe(1);
    expect(result.errors).toEqual([]);

    // Child mapping persisted → next passes are incremental, no re-reconcile needed
    const mappings = store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[];
    expect(mappings).toHaveLength(2);
    expect(mappings[1]).toMatchObject({ raindropCollectionId: 43, parentMappingId: 'm1' });
  });
});

describe('reconcileAllMappings with nested folders (browser-side wire)', () => {
  it('creates a child collection for a browser subfolder and pushes its bookmarks', async () => {
    // Russian user's case: mapped root "Work" has subfolder
    // "Notes" with a bookmark. Push must create the collection, the child
    // mapping, AND send the bookmark there.
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [{ ...mapping }];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [];
    api.getAllCollections.mockResolvedValue([collection({ _id: 42, title: 'Work' })]);
    api.getAllRaindropsInCollection.mockResolvedValue([]);
    api.createCollection.mockResolvedValue(
      collection({ _id: 44, title: 'Notes', parent: { $id: 42 } })
    );
    api.createRaindrops.mockResolvedValue([
      { _id: 20, link: 'https://notes.example.com/', title: 'Note 1' },
    ]);
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) => {
      if (id === 'ff-folder-1')
        return [{ id: 'ff-folder-3', title: 'Notes', parentId: 'ff-folder-1' }];
      if (id === 'ff-folder-3')
        return [
          {
            id: 'ff-bm-2',
            title: 'Note 1',
            parentId: 'ff-folder-3',
            url: 'https://notes.example.com/',
          },
        ];
      return [];
    });

    const result = await reconcileAllMappings();

    expect(api.createCollection).toHaveBeenCalledWith({
      title: 'Notes',
      parent: { $id: 42 },
    });
    expect(api.createRaindrops).toHaveBeenCalledWith([
      {
        link: 'https://notes.example.com/',
        title: 'Note 1',
        collection: { $id: 44 },
      },
    ]);
    expect(result.createdInRaindrop).toBe(1);
    expect(result.errors).toEqual([]);

    const mappings = store[STORAGE_KEYS.FOLDER_MAPPINGS] as FolderMapping[];
    expect(mappings).toHaveLength(2);
    expect(mappings[1]).toMatchObject({
      firefoxFolderId: 'ff-folder-3',
      raindropCollectionId: 44,
      parentMappingId: 'm1',
    });
  });
});

describe('performInitialSync with nested folders', () => {
  it('reconciles the tree and initial-syncs every descendant mapping (bug #3)', async () => {
    // Root "Work" + child collection "Projects" holding one
    // raindrop. Adding the mapping must build the subtree AND sync the
    // child's bookmarks — previously only the root got the initial sync.
    const rootMapping: FolderMapping = { ...mapping };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [rootMapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [];
    api.getAllCollections.mockResolvedValue([
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ]);
    api.getAllRaindropsInCollection.mockImplementation(async (id: number) =>
      id === 43
        ? [{ _id: 10, link: 'https://nested.example.com/', title: 'Nested' }]
        : []
    );
    let seq = 0;
    browserMock.bookmarks.create.mockImplementation(
      async (data: { parentId: string; title: string; url?: string }) => ({
        id: `ff-new-${seq++}`,
        ...data,
      })
    );

    const result = await performInitialSync(rootMapping);

    // Bookmark of the CHILD collection landed in the materialized subfolder
    expect(browserMock.bookmarks.create).toHaveBeenCalledWith({
      parentId: 'ff-new-0',
      title: 'Nested',
      url: 'https://nested.example.com/',
    });
    expect(result.createdInFirefox).toBe(1);
    expect(result.foldersSynced).toBe(2); // root + Projects
    expect(result.errors).toEqual([]);
  });

  it('does NOT materialize a browser bookmark for an already-linked raindrop', async () => {
    // Symmetric to the guard above: the bookmark ff-bm-1 is already linked to
    // raindrop 7, and raindrop 7 IS present in this collection. Skipping the
    // linked bookmark before matching must not leave its raindrop looking
    // "Raindrop-only" — otherwise initial sync creates a duplicate browser
    // bookmark for a URL that already exists locally.
    const rootMapping: FolderMapping = { ...mapping };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [rootMapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [{ ...link }]; // ff-bm-1 → raindrop 7
    api.getAllCollections.mockResolvedValue([collection({ _id: 42, title: 'Work' })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      { _id: 7, link: 'https://example.com/', title: 'Example' },
    ]);
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-bm-1', title: 'Example', url: 'https://example.com/', parentId: 'ff-folder-1' }]
        : []
    );

    const result = await performInitialSync(rootMapping);

    expect(browserMock.bookmarks.create).not.toHaveBeenCalled();
    expect(result.createdInFirefox).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe('syncFolderWithChildren (thin wrapper over reconcile)', () => {
  it('reconciles both directions from the mapped root (old impl was browser→raindrop only)', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [{ ...mapping }];
    api.getAllCollections.mockResolvedValue([
      collection({ _id: 42, title: 'Work' }),
      collection({ _id: 43, title: 'Projects', parent: { $id: 42 } }),
    ]);
    browserMock.bookmarks.create.mockResolvedValue({
      id: 'ff-folder-2',
      title: 'Projects',
    });

    const children = await syncFolderWithChildren('ff-folder-1', 42);

    // Raindrop-only child collection materialized — the one-way legacy
    // implementation never did this (task 001, bug #2).
    expect(browserMock.bookmarks.create).toHaveBeenCalledWith({
      parentId: 'ff-folder-1',
      title: 'Projects',
    });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ raindropCollectionId: 43, parentMappingId: 'm1' });
  });
});

// ---- enabled flag gates only AUTOMATIC sync (task 007) ----
// The "Enable Sync" toggle means "sync automatically". Manual Sync Now /
// Full Resync must run regardless; only the periodic alarm and event-driven
// triggers honour the flag, so reconcileAllMappings itself has no gate.

describe('manual sync runs even when auto-sync is disabled', () => {
  it('reconcileAllMappings syncs a new bookmark with sync disabled', async () => {
    store[STORAGE_KEYS.SYNC_SETTINGS] = { ...DEFAULT_SYNC_SETTINGS, enabled: false };
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [];
    api.getAllCollections.mockResolvedValue([collection({ _id: 42, title: 'Work' })]);
    api.getAllRaindropsInCollection.mockResolvedValue([]);
    api.createRaindrops.mockResolvedValue([
      { _id: 99, link: 'https://example.com/new', title: 'New' },
    ]);
    browserMock.bookmarks.getChildren.mockImplementation(async (id: string) =>
      id === 'ff-folder-1'
        ? [{ id: 'ff-b', title: 'New', parentId: 'ff-folder-1', url: 'https://example.com/new' }]
        : []
    );

    const result = await reconcileAllMappings();

    expect(api.createRaindrops).toHaveBeenCalled();
    expect(result.createdInRaindrop).toBe(1);
  });
});

describe('handleSyncAlarm honours the auto-sync toggle', () => {
  it('does NOT pull when auto-sync is disabled', async () => {
    store[STORAGE_KEYS.SYNC_SETTINGS] = { ...DEFAULT_SYNC_SETTINGS, enabled: false };
    api.getAllCollections.mockResolvedValue([collection({ _id: 42, title: 'Work' })]);
    api.getAllRaindropsInCollection.mockResolvedValue([]);

    await handleSyncAlarm({ name: 'raindrop-sync-interval' } as any);

    // periodic pull is the automatic path — it must be gated by the flag
    expect(api.getAllCollections).not.toHaveBeenCalled();
  });

  it('does pull when auto-sync is enabled', async () => {
    store[STORAGE_KEYS.SYNC_SETTINGS] = { ...DEFAULT_SYNC_SETTINGS, enabled: true };
    api.getAllCollections.mockResolvedValue([collection({ _id: 42, title: 'Work' })]);
    api.getAllRaindropsInCollection.mockResolvedValue([]);

    await handleSyncAlarm({ name: 'raindrop-sync-interval' } as any);

    expect(api.getAllCollections).toHaveBeenCalled();
  });

  it('catches up browser-side deletions on the periodic run (full sync)', async () => {
    // Deletion happened while the SW was asleep / toggle briefly off → the
    // onRemoved event was missed. The periodic reconcile must still propagate
    // it: bookmark gone, raindrop 7 alive and unchanged vs baseline → delete.
    const { computeRaindropHash } = await import('../utils/hash');
    store[STORAGE_KEYS.SYNC_SETTINGS] = { ...DEFAULT_SYNC_SETTINGS, enabled: true };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [
      { ...link, contentHash: computeRaindropHash('https://example.com/', 'Example') },
    ];
    api.getAllCollections.mockResolvedValue([collection({ _id: 42, title: 'Work' })]);
    api.getAllRaindropsInCollection.mockResolvedValue([
      { _id: 7, link: 'https://example.com/', title: 'Example' },
    ]);
    browserMock.bookmarks.getChildren.mockResolvedValue([]);
    browserMock.bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'ff-bm-1') throw new Error('Bookmark not found');
      return [{ id, title: 'x' }];
    });

    await handleSyncAlarm({ name: 'raindrop-sync-interval' } as any);

    expect(api.deleteRaindrop).toHaveBeenCalledWith(7);
  });
});

// ---- propagateBrowserFolderDeletions (task 010 P1, direction A) ----
//
// Bidirectional delete (iCloud/GDrive model): a mapped browser folder that was
// deleted must propagate the deletion to Raindrop — delete the collection
// (Raindrop cascades child collections; raindrops go to Trash) AND drop the
// mapping + links. Fail-closed: only a confirmed "bookmark not found" triggers
// deletion; a transient error must NOT delete anything. Supersedes 008 iter 2
// (which kept the collection).
describe('propagateBrowserFolderDeletions', () => {
  it('deletes the Raindrop collection and drops the mapping + links when the folder is gone', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping]; // collection 42
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    browserMock.bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'ff-folder-1') throw new Error("Can't find bookmark for id.");
      return [{ id, title: 'x' }];
    });

    const removed = await propagateBrowserFolderDeletions();

    expect(api.deleteCollection).toHaveBeenCalledWith(42);
    expect(removed).toContain('m1');
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([]);
    expect(store[STORAGE_KEYS.BOOKMARK_LINKS]).toEqual([]);
  });

  it('keeps a mapping whose folder still exists (no collection delete)', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    browserMock.bookmarks.get.mockResolvedValue([{ id: 'ff-folder-1', title: 'Work' }]);

    const removed = await propagateBrowserFolderDeletions();

    expect(removed).toEqual([]);
    expect(api.deleteCollection).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([mapping]);
  });

  it('fails closed: a transient (non "not found") error deletes NOTHING', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    browserMock.bookmarks.get.mockRejectedValue(new Error('Network error'));

    const removed = await propagateBrowserFolderDeletions();

    expect(removed).toEqual([]);
    expect(api.deleteCollection).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([mapping]);
  });

  it('tolerates deleteCollection 404 (already cascaded) — still drops the mapping', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    browserMock.bookmarks.get.mockRejectedValue(new Error("Can't find bookmark for id."));
    api.deleteCollection.mockRejectedValue(notFound404());

    const removed = await propagateBrowserFolderDeletions();

    expect(removed).toContain('m1');
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([]);
  });

  it('keeps the mapping when deleteCollection fails transiently (no orphaned collection)', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    browserMock.bookmarks.get.mockRejectedValue(new Error("Can't find bookmark for id."));
    api.deleteCollection.mockRejectedValue(new Error('Network error')); // no .status

    const removed = await propagateBrowserFolderDeletions();

    expect(removed).toEqual([]);
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([mapping]); // retry next sync
  });

  it('reconcileAllMappings propagates the deletion instead of erroring', async () => {
    store[STORAGE_KEYS.SYNC_SETTINGS] = { ...DEFAULT_SYNC_SETTINGS, enabled: true };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [{ ...mapping }];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    api.getAllCollections.mockResolvedValue([]); // collection already deleted this pass
    api.getAllRaindropsInCollection.mockResolvedValue([]);
    browserMock.bookmarks.get.mockRejectedValue(new Error("Can't find bookmark for id."));

    const result = await reconcileAllMappings();

    expect(api.deleteCollection).toHaveBeenCalledWith(42);
    expect(result.errors).toEqual([]);
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([]);
  });
});

// ---- propagateRaindropCollectionDeletions (task 010 P1, direction B) ----
//
// The other half of bidirectional delete: a Raindrop collection deleted on the
// server must remove the mapped browser folder (+ children) and drop the
// mapping. Fail-closed: an empty collections cache is NEVER acted on (a
// transient wipe would mass-delete every synced folder).
describe('propagateRaindropCollectionDeletions', () => {
  it('removes the folder + mapping when the collection is CONFIRMED (404) gone', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping]; // collection 42
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    const cache = [collection({ _id: 99, title: 'Other' })]; // 42 absent
    api.getCollection.mockRejectedValue(notFound404()); // confirm: really gone

    const removed = await propagateRaindropCollectionDeletions(cache);

    expect(api.getCollection).toHaveBeenCalledWith(42);
    expect(browserMock.bookmarks.removeTree).toHaveBeenCalledWith('ff-folder-1');
    expect(removed).toContain('m1');
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([]);
    expect(store[STORAGE_KEYS.BOOKMARK_LINKS]).toEqual([]);
  });

  it('keeps a mapping whose collection is present in the cache', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    const cache = [collection({ _id: 42, title: 'Work' })];

    const removed = await propagateRaindropCollectionDeletions(cache);

    expect(removed).toEqual([]);
    expect(api.getCollection).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.removeTree).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([mapping]);
  });

  it('KEEPS the folder when the cache is incomplete but the collection actually exists (confirm resolves)', async () => {
    // The catastrophic false-positive guard: 42 is missing from a non-empty
    // cache, but a direct fetch proves it is alive → must NOT delete.
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    const cache = [collection({ _id: 99, title: 'Other' })]; // 42 absent (incomplete)
    api.getCollection.mockResolvedValue(collection({ _id: 42, title: 'Work' }));

    const removed = await propagateRaindropCollectionDeletions(cache);

    expect(api.getCollection).toHaveBeenCalledWith(42);
    expect(removed).toEqual([]);
    expect(browserMock.bookmarks.removeTree).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([mapping]);
  });

  it('KEEPS the folder when the confirm fetch fails transiently (non-404)', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    const cache = [collection({ _id: 99, title: 'Other' })];
    api.getCollection.mockRejectedValue(new Error('Network error')); // no .status

    const removed = await propagateRaindropCollectionDeletions(cache);

    expect(removed).toEqual([]);
    expect(browserMock.bookmarks.removeTree).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([mapping]);
  });

  it('fails closed: an EMPTY cache deletes nothing (guards against a transient wipe)', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];

    const removed = await propagateRaindropCollectionDeletions([]);

    expect(removed).toEqual([]);
    expect(api.getCollection).not.toHaveBeenCalled();
    expect(browserMock.bookmarks.removeTree).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([mapping]);
  });

  it('tolerates removeTree failure (folder already gone) — still drops the mapping', async () => {
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping];
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    browserMock.bookmarks.removeTree.mockRejectedValue(new Error("Can't find bookmark for id."));
    api.getCollection.mockRejectedValue(notFound404());
    const cache = [collection({ _id: 99, title: 'Other' })];

    const removed = await propagateRaindropCollectionDeletions(cache);

    expect(removed).toContain('m1');
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([]);
  });

  it('reconcileAllMappings removes the folder when its collection was deleted in Raindrop', async () => {
    store[STORAGE_KEYS.SYNC_SETTINGS] = { ...DEFAULT_SYNC_SETTINGS, enabled: true };
    store[STORAGE_KEYS.FOLDER_MAPPINGS] = [mapping]; // collection 42
    store[STORAGE_KEYS.BOOKMARK_LINKS] = [link];
    // folder exists (so direction A leaves it alone), but collection 42 is gone
    browserMock.bookmarks.get.mockResolvedValue([{ id: 'ff-folder-1', title: 'Work' }]);
    api.getAllCollections.mockResolvedValue([collection({ _id: 99, title: 'Other' })]);
    api.getCollection.mockRejectedValue(notFound404()); // confirm 42 really gone
    api.getAllRaindropsInCollection.mockResolvedValue([]);

    await reconcileAllMappings();

    expect(browserMock.bookmarks.removeTree).toHaveBeenCalledWith('ff-folder-1');
    expect(store[STORAGE_KEYS.FOLDER_MAPPINGS]).toEqual([]);
  });
});
