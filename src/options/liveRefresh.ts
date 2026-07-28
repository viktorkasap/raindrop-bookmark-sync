// Live-refresh helpers for the Options page.
//
// The Options page is otherwise passive: it reads storage only in initialize()
// and after its own actions, so external changes (background sync alarm, folder
// deletion cascade, popup, a second tab) leave it stale. These pure helpers
// decide what to re-render in response to a storage.onChanged event; the DOM
// wiring lives in options.ts. Kept DOM-free so it is unit-testable under the
// node test environment.

import { STORAGE_KEYS } from '../types/storage';

/** Which Options sections need reloading after a storage.local change. */
export interface OptionsReloadPlan {
  /** Folder ↔ collection mappings list. */
  mappings: boolean;
  /** Enable toggle, sync interval, debug toggle. */
  settings: boolean;
  /** Stats counters (derive from sync_stats). */
  stats: boolean;
  /** The sync errors panel (derives from sync_errors, task 015). */
  errors: boolean;
}

/**
 * Map a storage.onChanged `changes` object to the Options sections that must be
 * re-rendered. `bookmark_links` and `api_token` intentionally trigger nothing —
 * they are not surfaced in this UI.
 */
export function storageChangeReloads(
  changes: Record<string, unknown>
): OptionsReloadPlan {
  return {
    mappings: STORAGE_KEYS.FOLDER_MAPPINGS in changes,
    settings: STORAGE_KEYS.SYNC_SETTINGS in changes,
    stats: STORAGE_KEYS.SYNC_STATS in changes,
    errors: STORAGE_KEYS.SYNC_ERRORS in changes,
  };
}
