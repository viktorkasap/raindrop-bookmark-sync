// Sync Manager - Core synchronization logic

import { FolderMapping, BookmarkLink, SyncErrorEntry, SyncErrorType } from '../types/storage';
import { SyncStatus } from '../types/messages';
import { Raindrop, Collection } from '../types/raindrop';
import {
  getSettings,
  updateSettings,
  getFolderMappings,
  addFolderMapping,
  updateFolderMapping,
  removeFolderMapping,
  getBookmarkLinks,
  saveBookmarkLinks,
  addBookmarkLink,
  updateBookmarkLink,
  removeBookmarkLink,
  updateSyncStats,
  getSyncStats,
  setSyncErrors,
  isAuthenticated as checkIsAuthenticated,
} from './storage';
import {
  getAllCollections,
  getAllRaindropsInCollection,
  createRaindrops,
  createCollection,
  updateCollection,
  updateRaindrop,
  deleteRaindrop,
  deleteCollection,
  getCollection,
  getCurrentUser,
} from './raindropApi';
import { setSyncing } from './bookmarkListeners';
import browser, { Bookmarks, Alarms } from 'webextension-polyfill';
import { logger } from '../utils/logger';
import {
  generateId,
  computeBookmarkHash,
  computeRaindropHash,
  normalizeUrl,
  urlsMatch,
  isValidSyncUrl,
} from '../utils/hash';
import { isBookmarkNode, isFolderNode } from '../utils/bookmarkNode';
import {
  namesMatch,
  decideBookmarkAction,
  decideRenameAction,
  type BookmarkSnapshot,
} from './reconcile';
import { getChildCollectionsOf } from '../utils/collections';

// ==================== Initial Sync ====================

export interface InitialSyncResult {
  matched: number;
  createdInRaindrop: number;
  createdInFirefox: number;
  foldersSynced: number;
  errors: string[];
}

// Since task 014 this is a thin wrapper over the unified three-way reconcile:
// build/refresh the folder↔collection subtree, then run one global reconcile
// pass. With no baseline (fresh mapping) the engine unions both sides by
// construction — same semantics the old initialSyncForMapping implemented by
// hand, minus its duplicate-creation races (task 013).
export async function performInitialSync(
  mapping: FolderMapping
): Promise<InitialSyncResult> {
  logger.info(`Starting initial sync for folder: ${mapping.folderName}`);

  // The subtree walk repeats inside reconcileAllMappings — accepted double
  // work on this rare path; the wrapper needs the subtree for foldersSynced.
  // One setSyncing envelope over both (the depth counter nests) so no
  // bookmark event slips through between the tree walk and the engine pass.
  const collectionsCache = await getAllCollections();
  setSyncing(true);
  let subtree: FolderMapping[];
  let r: ReconcileResult;
  try {
    subtree = await reconcileFolderTree(mapping, collectionsCache);
    r = await reconcileAllMappings();
  } finally {
    setSyncing(false);
  }
  const result: InitialSyncResult = {
    matched: r.adopted,
    createdInRaindrop: r.createdInRaindrop,
    createdInFirefox: r.createdInBrowser,
    foldersSynced: subtree.length,
    errors: r.errors,
  };
  logger.info('Initial sync completed', result);
  return result;
}

// ==================== Deletion Propagation (task 010) ====================

// Distinguish a genuine "bookmark does not exist" rejection from a transient
// error, so deletion catch-up can fail closed (task 006). Messages differ per
// browser: Firefox "Bookmark not found"; Chrome "Can't find bookmark for id.".
// A Raindrop API error carrying HTTP 404 — the collection genuinely does not
// exist (deleted). apiRequest attaches `.status` to the thrown error. Used to
// confirm a deletion before acting, so an incomplete collections list or a
// transient/network error never triggers a destructive folder removal.
function isCollectionNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: number }).status === 404
  );
}

function isBookmarkNotFoundError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // Must be specifically about a bookmark — guarding a destructive delete, so
  // a generic "... not found" (e.g. "Bookmarks database not found") must miss.
  return (
    /\bbookmark not found\b/.test(msg) || // Firefox
    /can'?t find bookmark/.test(msg) || // Chrome: "Can't find bookmark for id."
    /cannot find bookmark/.test(msg) ||
    /no bookmark (?:with )?id/.test(msg)
  );
}

/**
 * Propagate browser folder deletions to Raindrop (task 010, direction A).
 *
 * Bidirectional-delete model (iCloud/GDrive): a mapped browser folder that was
 * deleted must delete its Raindrop collection too, then drop the mapping.
 * `deleteCollection` cascades server-side — child collections are removed and
 * their raindrops go to Trash (verified against the API), so one call handles a
 * whole subtree. Running BEFORE reconcile (and re-fetching the collections
 * cache after) means the deleted collection is gone from the cache, so reconcile
 * never resurrects the folder.
 *
 * Fail-closed like the per-bookmark deletion catch-up: only a *confirmed*
 * "bookmark not found" triggers deletion. A transient error (network, etc.) is
 * treated as "folder still there" so a flaky read never destroys data.
 *
 * Supersedes task 008's prune, which kept the collection (that produced the
 * "deleted nested folder keeps coming back" bug — reconcile re-created it from
 * the surviving collection).
 *
 * Returns the ids of the removed mappings.
 */
export async function propagateBrowserFolderDeletions(): Promise<string[]> {
  const mappings = await getFolderMappings();
  const removedIds: string[] = [];

  for (const mapping of mappings) {
    try {
      // Fail-closed: act ONLY on a confirmed "bookmark not found". If get
      // resolves (with anything) the folder exists — keep. A transient error
      // (network, etc.) must never destroy data, so we swallow only the
      // specific not-found rejection and treat everything else as "keep".
      await browser.bookmarks.get(mapping.firefoxFolderId);
      continue; // folder exists → keep
    } catch (error) {
      if (!isBookmarkNotFoundError(error)) {
        logger.warn(
          `Skipping "${mapping.folderName}" — folder check failed with a non-not-found error`,
          error
        );
        continue;
      }
    }

    // Confirmed: the folder no longer exists in the browser → propagate delete.
    logger.info(
      `Folder for mapping "${mapping.folderName}" (${mapping.firefoxFolderId}) was deleted in the browser — deleting Raindrop collection ${mapping.raindropCollectionId} (cascades children; raindrops → Trash) and dropping the mapping`
    );

    let collectionGone = false;
    try {
      await deleteCollection(mapping.raindropCollectionId);
      collectionGone = true;
    } catch (error) {
      if (isCollectionNotFoundError(error)) {
        // Already gone (cascaded by an ancestor deleted earlier this pass).
        collectionGone = true;
      } else {
        // Transient/network failure — do NOT drop the mapping, or the
        // collection would be orphaned in Raindrop with no retry path. Keep it
        // and retry on the next sync. The mapping meanwhile points at a folder
        // that no longer exists; reconcile skips such a mapping (it does not
        // resurrect), so no duplicate is created before the retry succeeds.
        logger.warn(
          `deleteCollection(${mapping.raindropCollectionId}) failed transiently for "${mapping.folderName}" — keeping mapping to retry`,
          error
        );
      }
    }
    if (!collectionGone) continue;

    try {
      // Cascades to child mappings + drops all associated bookmark links.
      await removeFolderMapping(mapping.id);
      removedIds.push(mapping.id);
    } catch (error) {
      // One removal failing must not abort the whole sync.
      logger.error(`Failed to drop mapping "${mapping.folderName}"`, error);
    }
  }

  return removedIds;
}

/**
 * Propagate Raindrop collection deletions to the browser (task 010, direction B).
 *
 * The other half of bidirectional delete: a collection deleted on the server
 * removes the mapped browser folder (removeTree cascades child folders) and
 * drops the mapping (+ child mappings + links). Takes the already-fetched
 * collections cache so it shares one API read with the caller and can trust it.
 *
 * Fail-closed (data-loss guard): an EMPTY cache is never acted on. A folder
 * moved elsewhere keeps the same collection id, so only a truly absent id counts
 * as deleted. Must run inside setSyncing() — removeTree fires onRemoved events.
 *
 * Returns the ids of the removed mappings.
 */
export async function propagateRaindropCollectionDeletions(
  collectionsCache: Collection[]
): Promise<string[]> {
  const removedIds: string[] = [];

  // Too dangerous to act on an empty list — a transient wipe would mass-delete
  // every synced folder. getAllCollections throws on fetch failure, but the
  // blast radius of a false "empty" isn't worth it.
  if (collectionsCache.length === 0) {
    logger.warn(
      'Skipping Raindrop-side deletion propagation — empty collections cache'
    );
    return removedIds;
  }

  const liveIds = new Set(collectionsCache.map((c) => c._id));
  const mappings = await getFolderMappings();

  for (const mapping of mappings) {
    if (liveIds.has(mapping.raindropCollectionId)) continue; // collection alive

    // Absent from the cache is NOT proof of deletion — the list could be
    // incomplete (deep nesting, an API quirk). Before destroying a browser
    // folder, CONFIRM the collection is really gone with a direct fetch: a
    // successful fetch means the cache was incomplete → keep; only a 404
    // (confirmed deleted) proceeds; a transient error keeps it (fail-closed).
    try {
      await getCollection(mapping.raindropCollectionId);
      continue; // collection actually exists → cache was incomplete → keep
    } catch (error) {
      if (!isCollectionNotFoundError(error)) {
        logger.warn(
          `Keeping "${mapping.folderName}" — collection ${mapping.raindropCollectionId} existence check failed (non-404), not treating as deleted`,
          error
        );
        continue;
      }
    }

    logger.info(
      `Collection ${mapping.raindropCollectionId} ("${mapping.raindropCollectionName}") was deleted in Raindrop — removing browser folder ${mapping.firefoxFolderId} and dropping the mapping`
    );
    try {
      // Cascades to child folders in the browser.
      await browser.bookmarks.removeTree(mapping.firefoxFolderId);
    } catch (error) {
      // Folder may already be gone (cascaded with a parent removed earlier this
      // pass, or deleted by the user) — tolerate and still drop the mapping.
      logger.warn(
        `removeTree(${mapping.firefoxFolderId}) failed (may already be gone) for "${mapping.folderName}"`,
        error
      );
    }
    try {
      await removeFolderMapping(mapping.id);
      removedIds.push(mapping.id);
    } catch (error) {
      logger.error(`Failed to drop mapping "${mapping.folderName}"`, error);
    }
  }

  return removedIds;
}

// ==================== Unified Three-Way Reconcile (task 014) ====================

// Stale-tolerant storage lock: only one reconcile at a time, surviving MV3 SW
// restarts (same pattern the old queue used).
const RECONCILE_LOCK_KEY = 'reconcile_lock';
const RECONCILE_LOCK_TIMEOUT = 5 * 60 * 1000;

async function acquireReconcileLock(): Promise<boolean> {
  const result = await browser.storage.local.get(RECONCILE_LOCK_KEY);
  const lock = result[RECONCILE_LOCK_KEY] as { timestamp: number } | undefined;
  if (lock && Date.now() - lock.timestamp < RECONCILE_LOCK_TIMEOUT) return false;
  await browser.storage.local.set({
    [RECONCILE_LOCK_KEY]: { timestamp: Date.now() },
  });
  return true;
}

async function releaseReconcileLock(): Promise<void> {
  await browser.storage.local.remove(RECONCILE_LOCK_KEY);
}

// One shape for every link the reconcile creates — keeps the BookmarkLink
// schema in a single place across the adopt/create paths.
function buildLink(
  firefoxId: string,
  raindropId: number,
  url: string,
  title: string,
  contentHash: string,
  mappingId: string
): BookmarkLink {
  return {
    id: generateId(),
    firefoxId,
    raindropId,
    url,
    title,
    lastModified: Date.now(),
    contentHash,
    syncStatus: 'synced',
    mappingId,
  };
}

export interface ReconcileResult {
  pushed: number; // browser→Raindrop updates/moves of linked bookmarks
  pulled: number; // Raindrop→browser updates/moves/resurrections
  createdInRaindrop: number; // no-baseline browser-only bookmarks
  createdInBrowser: number; // no-baseline raindrop-only bookmarks
  adopted: number; // URL-matched pairs linked without creating anything
  deletedInRaindrop: number;
  deletedInBrowser: number;
  errors: string[];
}

// NOTE: no `settings.enabled` guard here — the toggle gates only the
// AUTOMATIC triggers (periodic alarm in handleSyncAlarm, event-driven path).
// Manual "Sync Now" / "Full Resync" call this directly and must run
// regardless (task 007).
export async function reconcileAllMappings(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    pushed: 0,
    pulled: 0,
    createdInRaindrop: 0,
    createdInBrowser: 0,
    adopted: 0,
    deletedInRaindrop: 0,
    deletedInBrowser: 0,
    errors: [],
  };

  if (!(await acquireReconcileLock())) {
    logger.debug('Reconcile already in progress (lock held), skipping');
    return result;
  }

  // Structured errors for the UI (task 015): same messages as result.errors,
  // plus a short `type` (which operation failed) so the Options panel can show
  // "type — message". Persisted (replace-all) at pass end, so a clean pass
  // clears them and a re-run reflects only the current state.
  const errorEntries: SyncErrorEntry[] = [];
  const recordError = (type: SyncErrorType, message: string): void => {
    result.errors.push(message);
    errorEntries.push({ type, message });
  };

  setSyncing(true);
  try {
    // Structural passes first — identical order to the old push/pull preamble.
    await propagateBrowserFolderDeletions();
    if ((await getFolderMappings()).length === 0) {
      await setSyncErrors([]);
      return result;
    }

    const collectionsCache = await getAllCollections();
    await propagateRaindropCollectionDeletions(collectionsCache);

    for (const root of (await getFolderMappings()).filter((m) => m.depth === 0)) {
      try {
        await reconcileFolderTree(root, collectionsCache);
      } catch (error) {
        const msg = `Failed to reconcile folder tree for ${root.folderName}: ${error}`;
        recordError('folder', msg);
        logger.error(msg);
      }
    }

    const allMappings = await getFolderMappings();
    const mappingById = new Map(allMappings.map((m) => [m.id, m]));
    const existingCollectionIds = new Set(collectionsCache.map((c) => c._id));

    // ---- Snapshot both sides globally (cross-mapping move detection) ----
    // A mapping whose side could not be read is UNAVAILABLE: its links are
    // skipped entirely, so a failed read never looks like "everything deleted"
    // (deletion-safety guard, parity with task 001).
    const unavailable = new Set<string>();

    const raindropsByMapping = new Map<string, Raindrop[]>();
    const raindropLoc = new Map<number, { raindrop: Raindrop; mappingId: string }>();
    for (const m of allMappings) {
      if (!existingCollectionIds.has(m.raindropCollectionId)) {
        logger.warn(
          `Collection ${m.raindropCollectionId} ("${m.raindropCollectionName}") not in cache, skipping mapping ${m.folderName}`
        );
        unavailable.add(m.id);
        continue;
      }
      try {
        const drops = await getAllRaindropsInCollection(m.raindropCollectionId);
        raindropsByMapping.set(m.id, drops);
        for (const r of drops) raindropLoc.set(r._id, { raindrop: r, mappingId: m.id });
      } catch (error) {
        unavailable.add(m.id);
        recordError('fetch', `Failed to fetch raindrops for ${m.folderName}: ${error}`);
      }
    }

    const browserByMapping = new Map<string, Bookmarks.BookmarkTreeNode[]>();
    const browserLoc = new Map<
      string,
      { node: Bookmarks.BookmarkTreeNode; mappingId: string }
    >();
    for (const m of allMappings) {
      try {
        const children = (
          await browser.bookmarks.getChildren(m.firefoxFolderId)
        ).filter(isBookmarkNode);
        browserByMapping.set(m.id, children);
        for (const b of children) browserLoc.set(b.id, { node: b, mappingId: m.id });
      } catch (error) {
        unavailable.add(m.id);
        logger.warn(`Failed to read browser folder for ${m.folderName}, skipping mapping`, error);
      }
    }

    // ---- Phase 1: linked bookmarks (baseline exists) — three-way per link ----
    const allLinks = await getBookmarkLinks();
    for (const link of allLinks) {
      if (!mappingById.has(link.mappingId) || unavailable.has(link.mappingId)) continue;
      const bLoc = browserLoc.get(link.firefoxId);
      const rLoc = raindropLoc.get(link.raindropId);
      // A side that resolved into an unavailable mapping can't be judged — skip.
      if (
        (bLoc && unavailable.has(bLoc.mappingId)) ||
        (rLoc && unavailable.has(rLoc.mappingId))
      ) {
        continue;
      }

      if (!bLoc) {
        // Not under any mapped folder. Deleted, or moved out of synced scope
        // (both mean "absent"), or an unreadable state — verify fail-closed.
        try {
          await browser.bookmarks.get(link.firefoxId); // alive → departed scope → absent
        } catch (error) {
          if (!isBookmarkNotFoundError(error)) continue; // can't verify → retry next pass
        }
      }

      const base: BookmarkSnapshot = { hash: link.contentHash, mappingId: link.mappingId };
      const browserSnap =
        bLoc && bLoc.node.url
          ? {
              hash: computeBookmarkHash(bLoc.node.url, bLoc.node.title),
              mappingId: bLoc.mappingId,
            }
          : null;
      const raindropSnap = rLoc
        ? {
            hash: computeRaindropHash(rLoc.raindrop.link, rLoc.raindrop.title),
            mappingId: rLoc.mappingId,
          }
        : null;

      try {
        switch (decideBookmarkAction(base, browserSnap, raindropSnap)) {
          case 'none':
            break;
          case 'push-update': {
            const target = mappingById.get(bLoc!.mappingId)!;
            const updates: Record<string, unknown> = {
              link: bLoc!.node.url,
              title: bLoc!.node.title,
            };
            if (bLoc!.mappingId !== link.mappingId) {
              updates.collection = { $id: target.raindropCollectionId }; // move preserves _id
            }
            await updateRaindrop(link.raindropId, updates);
            await updateBookmarkLink(link.id, {
              url: bLoc!.node.url!,
              title: bLoc!.node.title,
              contentHash: browserSnap!.hash,
              mappingId: bLoc!.mappingId,
              lastModified: Date.now(),
              syncStatus: 'synced',
            });
            result.pushed++;
            break;
          }
          case 'pull-update': {
            const target = mappingById.get(rLoc!.mappingId)!;
            let firefoxId = link.firefoxId;
            if (!bLoc) {
              // Delete-vs-edit conflict → Raindrop wins → resurrect in browser.
              const created = await browser.bookmarks.create({
                parentId: target.firefoxFolderId,
                title: rLoc!.raindrop.title,
                url: rLoc!.raindrop.link,
              });
              firefoxId = created.id;
            } else {
              if (browserSnap!.hash !== raindropSnap!.hash) {
                await browser.bookmarks.update(link.firefoxId, {
                  title: rLoc!.raindrop.title,
                  url: rLoc!.raindrop.link,
                });
              }
              if (bLoc.mappingId !== rLoc!.mappingId) {
                await browser.bookmarks.move(link.firefoxId, {
                  parentId: target.firefoxFolderId,
                });
              }
            }
            await updateBookmarkLink(link.id, {
              firefoxId,
              url: rLoc!.raindrop.link,
              title: rLoc!.raindrop.title,
              contentHash: raindropSnap!.hash,
              mappingId: rLoc!.mappingId,
              lastModified: Date.now(),
              syncStatus: 'synced',
            });
            result.pulled++;
            break;
          }
          case 'delete-in-raindrop':
            await deleteRaindrop(link.raindropId); // Raindrop Trash keeps it recoverable
            await removeBookmarkLink(link.id);
            result.deletedInRaindrop++;
            break;
          case 'delete-in-browser':
            try {
              await browser.bookmarks.remove(link.firefoxId);
            } catch {
              // already gone
            }
            await removeBookmarkLink(link.id);
            result.deletedInBrowser++;
            break;
          case 'drop-link':
            await removeBookmarkLink(link.id);
            break;
        }
      } catch (error) {
        recordError('sync', `Reconcile failed for "${link.title}": ${error}`);
      }
    }

    // ---- Phases 2+3: no baseline → union/merge, never delete ----
    const linksAfter = await getBookmarkLinks();
    const linkedFirefoxIds = new Set(linksAfter.map((l) => l.firefoxId));
    const linkedRaindropIds = new Set(linksAfter.map((l) => l.raindropId));
    const linkedUrls = new Set(linksAfter.map((l) => normalizeUrl(l.url)));
    // Anything that HAD a baseline entering phase 1 was fully handled there.
    // The side snapshots are stale by now (a raindrop deleted in phase 1 is
    // still in raindropsByMapping, a removed bookmark still in
    // browserByMapping) — without this union a phase-1 deletion would be
    // resurrected here as a "new" object, oscillating on every pass.
    for (const l of allLinks) {
      linkedFirefoxIds.add(l.firefoxId);
      linkedRaindropIds.add(l.raindropId);
      linkedUrls.add(normalizeUrl(l.url));
    }

    for (const m of allMappings) {
      if (unavailable.has(m.id)) continue;

      const unlinkedDropByUrl = new Map<string, Raindrop>();
      for (const r of raindropsByMapping.get(m.id) ?? []) {
        if (!linkedRaindropIds.has(r._id)) unlinkedDropByUrl.set(normalizeUrl(r.link), r);
      }

      // Phase 2: browser-only bookmarks → adopt by URL, else create in Raindrop.
      const toCreate: Bookmarks.BookmarkTreeNode[] = [];
      for (const node of browserByMapping.get(m.id) ?? []) {
        if (!node.url || !isValidSyncUrl(node.url) || linkedFirefoxIds.has(node.id)) continue;
        const normalized = normalizeUrl(node.url);
        const match = unlinkedDropByUrl.get(normalized);
        if (match) {
          // Same URL on both sides → adopt: link them; Raindrop wins content.
          try {
            if (
              computeBookmarkHash(node.url, node.title) !==
              computeRaindropHash(match.link, match.title)
            ) {
              await browser.bookmarks.update(node.id, {
                title: match.title,
                url: match.link,
              });
            }
            await addBookmarkLink(
              buildLink(
                node.id,
                match._id,
                match.link,
                match.title,
                computeRaindropHash(match.link, match.title),
                m.id
              )
            );
            unlinkedDropByUrl.delete(normalized);
            linkedRaindropIds.add(match._id);
            linkedUrls.add(normalized);
            result.adopted++;
          } catch (error) {
            // One bad adoption must not abort the rest of the pass.
            recordError('sync', `Failed to adopt "${node.title}": ${error}`);
          }
        } else {
          toCreate.push(node);
        }
      }
      if (toCreate.length > 0) {
        try {
          const created = await createRaindrops(
            toCreate.map((b) => ({
              link: b.url!,
              title: b.title,
              collection: { $id: m.raindropCollectionId },
            }))
          );
          // Splice-match back by URL — never link the same bookmark twice.
          const remaining = [...toCreate];
          for (const createdDrop of created) {
            const idx = remaining.findIndex(
              (b) => b.url && urlsMatch(b.url, createdDrop.link)
            );
            if (idx === -1) continue;
            const [node] = remaining.splice(idx, 1);
            await addBookmarkLink(
              buildLink(
                node.id,
                createdDrop._id,
                createdDrop.link,
                createdDrop.title,
                computeBookmarkHash(createdDrop.link, createdDrop.title),
                m.id
              )
            );
            linkedUrls.add(normalizeUrl(createdDrop.link));
            result.createdInRaindrop++;
          }
        } catch (error) {
          recordError('create', `Bulk create in Raindrop failed for ${m.folderName}: ${error}`);
        }
      }

      // Phase 3: raindrop-only → create in browser (URL-dedup loop-killer kept).
      for (const r of unlinkedDropByUrl.values()) {
        const normalized = normalizeUrl(r.link);
        if (linkedUrls.has(normalized)) {
          logger.debug(`Raindrop ${r._id} URL already linked, skipping duplicate`);
          continue;
        }
        try {
          const created = await browser.bookmarks.create({
            parentId: m.firefoxFolderId,
            title: r.title,
            url: r.link,
          });
          await addBookmarkLink(
            buildLink(
              created.id,
              r._id,
              r.link,
              r.title,
              computeRaindropHash(r.link, r.title),
              m.id
            )
          );
          linkedUrls.add(normalized);
          result.createdInBrowser++;
        } catch (error) {
          recordError('create', `Failed to create bookmark for "${r.title}": ${error}`);
        }
      }

      await updateFolderMapping(m.id, { lastSync: Date.now() });
    }

    // Persist this pass's outcome (replace-all: clean → []). A failure to WRITE
    // the results is not a sync failure — the work already happened — so log it
    // rather than let it fall into the pass-aborted catch below and get
    // mislabelled as a 'connection' error.
    try {
      await setSyncErrors(errorEntries);
      await updateSyncStats({
        lastSyncTime: Date.now(),
        lastSyncStatus: result.errors.length === 0 ? 'success' : 'partial',
      });
    } catch (persistError) {
      logger.error('Failed to persist reconcile results', persistError);
    }
    logger.info('Reconcile completed', result);
    return result;
  } catch (error) {
    // A failure that aborted the whole pass (e.g. the collection fetch threw —
    // offline / server down / bad token). Surface it in the panel as a
    // connection error so a fully-failed background pass isn't silent.
    recordError('connection', `Sync failed: ${error}`);
    await setSyncErrors(errorEntries);
    await updateSyncStats({ lastSyncTime: Date.now(), lastSyncStatus: 'failed' });
    throw error;
  } finally {
    setSyncing(false);
    await releaseReconcileLock();
  }
}

// ==================== Nested Folder Sync ====================

// Safety ceiling against runaway recursion, not a feature limit: Raindrop.io
// accepts far deeper nesting (probed ≥8 levels), and real bookmark trees are
// rarely deeper than a handful. 20 covers any realistic tree while still
// bounding pathological cases (task 007). Raise if a real use case needs it.
const MAX_SYNC_DEPTH = 20;


/**
 * Recursive structural reconciliation of a mapped folder↔collection pair
 * (task 001). Walks both sides' children, creates whatever is missing
 * (folders, collections, child mappings), and recurses. Idempotent:
 * re-running on an already reconciled tree creates nothing.
 *
 * Returns every mapping in the subtree, including `mapping` itself.
 */
export async function reconcileFolderTree(
  mapping: FolderMapping,
  collectionsCache: Collection[],
  depth = 0
): Promise<FolderMapping[]> {
  const result: FolderMapping[] = [mapping];

  if (depth >= MAX_SYNC_DEPTH) {
    logger.warn(`Max sync depth (${MAX_SYNC_DEPTH}) reached, stopping reconciliation`);
    return result;
  }

  // The mapping's own collection is gone (root resurrection is out of scope
  // for task 001): reconciling anyway would create child collections under a
  // dead parent id. Bail out; the pull guard already skips this mapping.
  if (!collectionsCache.some((c) => c._id === mapping.raindropCollectionId)) {
    logger.warn(
      `Collection ${mapping.raindropCollectionId} ("${mapping.raindropCollectionName}") not found, skipping reconciliation for ${mapping.folderName}`
    );
    return result;
  }

  setSyncing(true);
  try {
    // Existing mappings are authoritative (grilling decision #1): a pair
    // already linked by a mapping is never re-matched by name.
    const allMappings = await getFolderMappings();
    const mappingByCollectionId = new Map<number, FolderMapping>();
    for (const m of allMappings) {
      mappingByCollectionId.set(m.raindropCollectionId, m);
    }

    const mappingByFolderId = new Map<string, FolderMapping>();
    for (const m of allMappings) {
      mappingByFolderId.set(m.firefoxFolderId, m);
    }

    const browserChildren = await browser.bookmarks.getChildren(
      mapping.firefoxFolderId
    );
    const subfolders = browserChildren.filter(isFolderNode);

    // Unmapped browser subfolders → match an existing child collection by
    // name (discovery only — existing mappings already handled above), or
    // create a new collection.
    for (const subfolder of subfolders) {
      const linkedMapping = mappingByFolderId.get(subfolder.id);
      if (linkedMapping) {
        // A collection deleted in Raindrop while its folder lives on is
        // handled by propagateRaindropCollectionDeletions (Direction B),
        // which runs before reconcile and removes the folder + mapping. So
        // there is nothing to resurrect here — the linked pair is handled by
        // the collection pass below.
        continue;
      }

      const nameMatch = getChildCollectionsOf(
        mapping.raindropCollectionId,
        collectionsCache
      ).find(
        (c) =>
          !mappingByCollectionId.has(c._id) &&
          namesMatch(c.title, subfolder.title)
      );

      const childCollection =
        nameMatch ??
        (await createCollection({
          title: subfolder.title,
          parent: { $id: mapping.raindropCollectionId },
        }));
      if (!nameMatch) {
        collectionsCache.push(childCollection); // visible to recursion below
      }

      const childMapping: FolderMapping = {
        id: generateId(),
        firefoxFolderId: subfolder.id,
        raindropCollectionId: childCollection._id,
        folderName: subfolder.title,
        raindropCollectionName: childCollection.title,
        parentMappingId: mapping.id,
        depth: mapping.depth + 1,
        lastSync: 0,
      };
      await addFolderMapping(childMapping);
      // Make the freshly created child collection visible to the collection
      // pass below so it is not processed a second time.
      mappingByCollectionId.set(childCollection._id, childMapping);
    }

    // Recompute AFTER the browser pass so freshly created collections are
    // included — their subtrees still need recursion.
    const childCollections = getChildCollectionsOf(
      mapping.raindropCollectionId,
      collectionsCache
    );

    for (const childCollection of childCollections) {
      const existingMapping = mappingByCollectionId.get(childCollection._id);

      let childMapping: FolderMapping;
      if (existingMapping) {
        childMapping = existingMapping;

        // Locate the mapped browser folder — a direct child, or moved
        // elsewhere but still alive (verify with bookmarks.get; "not a direct
        // child" alone is not proof of deletion). A folder deleted in the
        // browser is removed together with its collection by
        // propagateBrowserFolderDeletions (Direction A) before reconcile
        // runs, so reaching here with a genuinely missing folder is an
        // inconsistent state — skip it (Direction A cleans it next pass)
        // rather than resurrecting it.
        let browserFolder = subfolders.find(
          (f) => f.id === existingMapping.firefoxFolderId
        );
        if (!browserFolder) {
          try {
            [browserFolder] = await browser.bookmarks.get(
              childMapping.firefoxFolderId
            );
          } catch {
            browserFolder = undefined;
          }
        }
        if (!browserFolder) continue;

        // Rename B↔R (task 014): three-way against the baseline name
        // (mapping.folderName = the name at last sync). Changed only in the
        // browser → push to Raindrop; changed only in Raindrop → pull;
        // both → conflict → Raindrop wins. ci+trim drift is not a rename.
        const renameAction = decideRenameAction(
          existingMapping.folderName,
          browserFolder.title,
          childCollection.title
        );
        if (renameAction === 'pull-rename') {
          await browser.bookmarks.update(childMapping.firefoxFolderId, {
            title: childCollection.title,
          });
        } else if (renameAction === 'push-rename') {
          await updateCollection(childCollection._id, {
            title: browserFolder.title,
          });
          // Keep the shared cache honest for the recursion below.
          childCollection.title = browserFolder.title;
        }
        const syncedName = childCollection.title;
        if (
          !namesMatch(existingMapping.folderName, syncedName) ||
          existingMapping.raindropCollectionName !== syncedName
        ) {
          childMapping = {
            ...childMapping,
            folderName: syncedName,
            raindropCollectionName: syncedName,
          };
          await updateFolderMapping(existingMapping.id, {
            folderName: syncedName,
            raindropCollectionName: syncedName,
          });
        }
      } else {
        // Raindrop-only child collection → materialize as a browser folder
        const folder = await browser.bookmarks.create({
          parentId: mapping.firefoxFolderId,
          title: childCollection.title,
        });

        childMapping = {
          id: generateId(),
          firefoxFolderId: folder.id,
          raindropCollectionId: childCollection._id,
          folderName: childCollection.title,
          raindropCollectionName: childCollection.title,
          parentMappingId: mapping.id,
          depth: mapping.depth + 1,
          lastSync: 0,
        };
        await addFolderMapping(childMapping);
      }

      const subtree = await reconcileFolderTree(
        childMapping,
        collectionsCache,
        depth + 1
      );
      result.push(...subtree);
    }

    return result;
  } finally {
    setSyncing(false);
  }
}

/**
 * Legacy entry point kept for the `syncFolderWithChildren` message —
 * now a thin wrapper over reconcileFolderTree (task 001). The folder
 * must already be mapped; returns the child mappings of the subtree.
 */
export async function syncFolderWithChildren(
  firefoxFolderId: string,
  _raindropParentId: number | null
): Promise<FolderMapping[]> {
  const mappings = await getFolderMappings();
  const rootMapping = mappings.find(
    (m) => m.firefoxFolderId === firefoxFolderId
  );
  if (!rootMapping) {
    logger.warn(
      `syncFolderWithChildren: no mapping found for folder ${firefoxFolderId}`
    );
    return [];
  }

  const collectionsCache = await getAllCollections();
  const subtree = await reconcileFolderTree(rootMapping, collectionsCache);
  return subtree.filter((m) => m.id !== rootMapping.id);
}

// ==================== Full Re-sync ====================

export async function performFullResync(): Promise<{
  success: boolean;
  results: InitialSyncResult[];
  errors: string[];
}> {
  const results: InitialSyncResult[] = [];
  const errors: string[] = [];

  const mappings = await getFolderMappings();

  if (mappings.length === 0) {
    return { success: true, results: [], errors: ['No mappings configured'] };
  }

  // Clear existing links
  await saveBookmarkLinks([]);

  // One global pass (task 014): with the link table cleared there is no
  // baseline, so the engine unions every mapping (never deletes) and rebuilds
  // all links. Looping performInitialSync per mapping would run the same
  // global reconcile N times, attributing everything to the first mapping.
  try {
    const r = await reconcileAllMappings();
    results.push({
      matched: r.adopted,
      createdInRaindrop: r.createdInRaindrop,
      createdInFirefox: r.createdInBrowser,
      foldersSynced: (await getFolderMappings()).length,
      errors: r.errors,
    });
    errors.push(...r.errors);
  } catch (error) {
    errors.push(`Full resync failed: ${error}`);
  }

  await updateSettings({ lastFullSync: Date.now() });

  return {
    success: errors.length === 0,
    results,
    errors,
  };
}

// ==================== Periodic Sync Setup ====================

let syncAlarmName = 'raindrop-sync-interval';

export async function setupPeriodicSync(): Promise<void> {
  const settings = await getSettings();

  if (settings.enabled && settings.syncInterval > 0) {
    // Only create alarm if it doesn't exist or the interval changed.
    // Avoids resetting the timer on every Service Worker restart in Chrome MV3.
    const existing = await browser.alarms.get(syncAlarmName);
    if (!existing || existing.periodInMinutes !== settings.syncInterval) {
      await browser.alarms.clear(syncAlarmName);
      await browser.alarms.create(syncAlarmName, {
        periodInMinutes: settings.syncInterval,
      });
      logger.info(`Periodic sync set up: every ${settings.syncInterval} minutes`);
    }
  } else {
    await browser.alarms.clear(syncAlarmName);
  }
}

export async function handleSyncAlarm(
  alarm: Alarms.Alarm
): Promise<void> {
  if (alarm.name === syncAlarmName) {
    // Automatic path: honour the "Enable Sync" toggle (task 007). Manual
    // sync bypasses this by calling reconcileAllMappings directly.
    const settings = await getSettings();
    if (!settings.enabled) {
      logger.debug('Auto-sync disabled, skipping periodic pull');
      return;
    }
    logger.info('Periodic sync triggered');
    // One unified three-way pass (task 014) — catches up both directions,
    // including deletions the real-time events missed.
    await reconcileAllMappings();
  }
}

// ==================== Status ====================

// Re-export SyncStatus for consumers that import from syncManager
export type { SyncStatus } from '../types/messages';

// Cache username to avoid API call on every popup open
let cachedUserName: string | undefined;

export function clearCachedUser(): void {
  cachedUserName = undefined;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const isAuth = await checkIsAuthenticated();
  const settings = await getSettings();
  const mappings = await getFolderMappings();
  const links = await getBookmarkLinks();
  const stats = await getSyncStats();
  const { isSyncInProgress } = await import('./bookmarkListeners');

  let userName: string | undefined;

  if (isAuth) {
    if (cachedUserName) {
      userName = cachedUserName;
    } else {
      try {
        const user = await getCurrentUser();
        cachedUserName = user.fullName;
        userName = cachedUserName;
      } catch {
        // Token may be invalid
      }
    }
  } else {
    cachedUserName = undefined;
  }

  return {
    isAuthenticated: isAuth,
    isEnabled: settings.enabled,
    isSyncing: isSyncInProgress(),
    mappingsCount: mappings.length,
    linksCount: links.length,
    lastSyncTime: stats.lastSyncTime,
    lastSyncStatus: stats.lastSyncStatus,
    userName,
  };
}

