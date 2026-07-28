import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FolderMapping, BookmarkLink } from '../types/storage';
import { computeBookmarkHash } from '../utils/hash';

// ---- Boundary mocks: webextension-polyfill + storage + syncManager ----
//
// Events no longer carry a payload — every relevant bookmark event just fires a
// single debounced reconcile (task 014). So the tests assert on
// reconcileAllMappings call counts, not on queued operations.

const { browserMock, storageMock, reconcileMock } = vi.hoisted(() => {
  const listener: {
    onCreated?: (id: string, node: unknown) => Promise<void>;
    onRemoved?: (id: string, info: unknown) => Promise<void>;
    onChanged?: (id: string, info: unknown) => Promise<void>;
    onMoved?: (id: string, info: unknown) => Promise<void>;
  } = {};
  const capture =
    (key: keyof typeof listener) =>
    (fn: (id: string, info: unknown) => Promise<void>) => {
      listener[key] = fn;
    };
  const browserMock = {
    bookmarks: {
      onCreated: { addListener: vi.fn(capture('onCreated')), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(capture('onRemoved')), removeListener: vi.fn() },
      onChanged: { addListener: vi.fn(capture('onChanged')), removeListener: vi.fn() },
      onMoved: { addListener: vi.fn(capture('onMoved')), removeListener: vi.fn() },
      get: vi.fn(async (id: string) => [{ id, title: id }]),
    },
    _listener: listener,
  };
  const storageMock = {
    getSettings: vi.fn(async () => ({ enabled: true }) as { enabled: boolean }),
    isAuthenticated: vi.fn(async () => true),
    findMappingByFirefoxId: vi.fn(
      async (_id: string): Promise<FolderMapping | null> => null
    ),
    findBookmarkLink: vi.fn(
      async (_id: string): Promise<BookmarkLink | null> => null
    ),
  };
  const reconcileMock = { reconcileAllMappings: vi.fn(async () => ({})) };
  return { browserMock, storageMock, reconcileMock };
});

vi.mock('webextension-polyfill', () => ({ default: browserMock }));
vi.mock('./storage', () => storageMock);
vi.mock('./syncManager', () => reconcileMock);

import {
  registerBookmarkListeners,
  unregisterBookmarkListeners,
  setSyncing,
} from './bookmarkListeners';

// ---- Fixtures ----

const mappingB1: FolderMapping = {
  id: 'm1',
  firefoxFolderId: 'B1',
  raindropCollectionId: 42,
  folderName: 'B1',
  raindropCollectionName: 'B1',
  depth: 0,
  lastSync: 0,
};

const link: BookmarkLink = {
  id: 'l1',
  firefoxId: 'X',
  raindropId: 7,
  url: 'https://example.com/',
  title: 'Example',
  lastModified: 0,
  contentHash: computeBookmarkHash('https://example.com/', 'Example'),
  syncStatus: 'synced',
  mappingId: 'm1',
};

// Register listeners once and grab the captured handlers.
registerBookmarkListeners();
const on = browserMock._listener;

// The debounced reconcile fires 800ms after the last relevant event, then
// resolves a dynamic import('./syncManager') before calling reconcile.
async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(800);
  // Let the dynamic import().then() microtasks settle.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  storageMock.getSettings.mockResolvedValue({ enabled: true });
  storageMock.isAuthenticated.mockResolvedValue(true);
  storageMock.findMappingByFirefoxId.mockResolvedValue(null);
  storageMock.findBookmarkLink.mockResolvedValue(null);
  browserMock.bookmarks.get.mockImplementation(async (id: string) => [
    { id, title: id },
  ]);
  reconcileMock.reconcileAllMappings.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debounced reconcile trigger', () => {
  it('collapses a burst of creates into a single reconcile', async () => {
    storageMock.findMappingByFirefoxId.mockImplementation(async (id: string) =>
      id === 'B1' ? mappingB1 : null
    );
    const node = (id: string) => ({
      id,
      title: `t-${id}`,
      url: `https://example.com/${id}`,
      parentId: 'B1',
    });

    await on.onCreated!('a', node('a'));
    await on.onCreated!('b', node('b'));
    await on.onCreated!('c', node('c'));
    await flushDebounce();

    expect(reconcileMock.reconcileAllMappings).toHaveBeenCalledTimes(1);
  });

  it('never reconciles for an event fired during an in-progress sync', async () => {
    storageMock.findMappingByFirefoxId.mockImplementation(async (id: string) =>
      id === 'B1' ? mappingB1 : null
    );
    setSyncing(true);
    await on.onCreated!('a', {
      id: 'a',
      title: 't',
      url: 'https://example.com/a',
      parentId: 'B1',
    });
    await flushDebounce();
    setSyncing(false);

    expect(reconcileMock.reconcileAllMappings).not.toHaveBeenCalled();
  });

  it('never reconciles when auto-sync is disabled', async () => {
    storageMock.getSettings.mockResolvedValue({ enabled: false });
    storageMock.findMappingByFirefoxId.mockImplementation(async (id: string) =>
      id === 'B1' ? mappingB1 : null
    );
    await on.onCreated!('a', {
      id: 'a',
      title: 't',
      url: 'https://example.com/a',
      parentId: 'B1',
    });
    await flushDebounce();

    expect(reconcileMock.reconcileAllMappings).not.toHaveBeenCalled();
  });

  it('cancels a pending reconcile when listeners are unregistered (disable/disconnect)', async () => {
    // A timer armed just before the user disables auto-sync or disconnects must
    // not fire — reconcileAllMappings has no enabled gate, so a late pass would
    // push/pull after teardown (regresses task 007 / task 011). All teardown
    // paths call unregisterBookmarkListeners, so it must clear the timer.
    storageMock.findMappingByFirefoxId.mockImplementation(async (id: string) =>
      id === 'B1' ? mappingB1 : null
    );
    await on.onCreated!('a', {
      id: 'a',
      title: 't',
      url: 'https://example.com/a',
      parentId: 'B1',
    });

    unregisterBookmarkListeners();
    await flushDebounce();
    registerBookmarkListeners(); // restore for later tests

    expect(reconcileMock.reconcileAllMappings).not.toHaveBeenCalled();
  });

  it('ignores a create in a folder with no synced ancestor', async () => {
    // No mapping anywhere up the tree → irrelevant.
    await on.onCreated!('a', {
      id: 'a',
      title: 't',
      url: 'https://example.com/a',
      parentId: 'UNMAPPED',
    });
    await flushDebounce();

    expect(reconcileMock.reconcileAllMappings).not.toHaveBeenCalled();
  });
});

describe('handleBookmarkMoved', () => {
  it('reconciles when moved into an unmapped subfolder of a synced tree', async () => {
    // X moved from B1 (mapped) into B2 (a fresh subfolder of B1, not yet
    // mapped). B2 sits inside the synced tree → relevant. Reconcile maps B2 and
    // moves the raindrop preserving its _id.
    storageMock.findMappingByFirefoxId.mockImplementation(async (id: string) =>
      id === 'B1' ? mappingB1 : null
    );
    storageMock.findBookmarkLink.mockResolvedValue(link);
    browserMock.bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'B2') return [{ id: 'B2', title: 'B2', parentId: 'B1' }];
      return [{ id, title: id }];
    });

    await on.onMoved!('X', { oldParentId: 'B1', parentId: 'B2', index: 0, oldIndex: 0 });
    await flushDebounce();

    expect(reconcileMock.reconcileAllMappings).toHaveBeenCalledTimes(1);
  });

  it('reconciles when moved out of every synced tree (delete propagates)', async () => {
    // X moved from B1 (mapped) into OUT, no mapped ancestor. The link exists, so
    // reconcile must run — Phase 1 sees "alive but out of scope" and deletes the
    // raindrop.
    storageMock.findMappingByFirefoxId.mockImplementation(async (id: string) =>
      id === 'B1' ? mappingB1 : null
    );
    storageMock.findBookmarkLink.mockResolvedValue(link);
    browserMock.bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'OUT') return [{ id: 'OUT', title: 'OUT', parentId: 'root' }];
      if (id === 'root') return [{ id: 'root', title: 'root' }];
      return [{ id, title: id }];
    });

    await on.onMoved!('X', { oldParentId: 'B1', parentId: 'OUT', index: 0, oldIndex: 0 });
    await flushDebounce();

    expect(reconcileMock.reconcileAllMappings).toHaveBeenCalledTimes(1);
  });

  it('ignores a move between two unsynced folders', async () => {
    await on.onMoved!('Y', { oldParentId: 'U1', parentId: 'U2', index: 0, oldIndex: 0 });
    await flushDebounce();

    expect(reconcileMock.reconcileAllMappings).not.toHaveBeenCalled();
  });
});

describe('handleBookmarkRemoved', () => {
  it('reconciles when a linked bookmark is removed', async () => {
    storageMock.findBookmarkLink.mockResolvedValue(link);
    await on.onRemoved!('X', { parentId: 'B1', index: 0, node: {} });
    await flushDebounce();
    expect(reconcileMock.reconcileAllMappings).toHaveBeenCalledTimes(1);
  });

  it('reconciles when a mapped folder is removed', async () => {
    storageMock.findMappingByFirefoxId.mockImplementation(async (id: string) =>
      id === 'B1' ? mappingB1 : null
    );
    await on.onRemoved!('B1', { parentId: 'root', index: 0, node: {} });
    await flushDebounce();
    expect(reconcileMock.reconcileAllMappings).toHaveBeenCalledTimes(1);
  });

  it('ignores removal of an unlinked, unmapped node', async () => {
    await on.onRemoved!('Z', { parentId: 'root', index: 0, node: {} });
    await flushDebounce();
    expect(reconcileMock.reconcileAllMappings).not.toHaveBeenCalled();
  });
});

describe('handleBookmarkChanged', () => {
  it('reconciles when a linked bookmark content changes', async () => {
    storageMock.findBookmarkLink.mockResolvedValue(link);
    await on.onChanged!('X', { title: 'New title', url: 'https://example.com/' });
    await flushDebounce();
    expect(reconcileMock.reconcileAllMappings).toHaveBeenCalledTimes(1);
  });

  it('ignores a change whose content hash is unchanged', async () => {
    storageMock.findBookmarkLink.mockResolvedValue(link);
    await on.onChanged!('X', { title: 'Example', url: 'https://example.com/' });
    await flushDebounce();
    expect(reconcileMock.reconcileAllMappings).not.toHaveBeenCalled();
  });

  it('reconciles when a mapped folder is renamed', async () => {
    storageMock.findMappingByFirefoxId.mockImplementation(async (id: string) =>
      id === 'B1' ? mappingB1 : null
    );
    await on.onChanged!('B1', { title: 'Renamed folder' });
    await flushDebounce();
    expect(reconcileMock.reconcileAllMappings).toHaveBeenCalledTimes(1);
  });
});
