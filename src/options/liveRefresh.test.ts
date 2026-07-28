import { describe, it, expect } from 'vitest';
import { storageChangeReloads } from './liveRefresh';
import { STORAGE_KEYS } from '../types/storage';

describe('storageChangeReloads', () => {
  it('reloads mappings when folder_mappings changes', () => {
    const plan = storageChangeReloads({ [STORAGE_KEYS.FOLDER_MAPPINGS]: {} });
    expect(plan.mappings).toBe(true);
    expect(plan.settings).toBe(false);
    expect(plan.stats).toBe(false);
  });

  it('reloads settings when sync_settings changes', () => {
    const plan = storageChangeReloads({ [STORAGE_KEYS.SYNC_SETTINGS]: {} });
    expect(plan.settings).toBe(true);
    expect(plan.mappings).toBe(false);
  });

  it('reloads stats when sync_stats changes', () => {
    const plan = storageChangeReloads({ [STORAGE_KEYS.SYNC_STATS]: {} });
    expect(plan.stats).toBe(true);
  });

  it('reloads the errors panel when sync_errors changes (task 015)', () => {
    const plan = storageChangeReloads({ [STORAGE_KEYS.SYNC_ERRORS]: {} });
    expect(plan.errors).toBe(true);
    expect(plan.mappings).toBe(false);
    expect(plan.stats).toBe(false);
  });

  it('reloads several sections when multiple keys change at once', () => {
    const plan = storageChangeReloads({
      [STORAGE_KEYS.FOLDER_MAPPINGS]: {},
      [STORAGE_KEYS.SYNC_STATS]: {},
    });
    expect(plan.mappings).toBe(true);
    expect(plan.stats).toBe(true);
    expect(plan.settings).toBe(false);
  });

  it('does not reload anything for unrelated keys (e.g. bookmark_links, api_token)', () => {
    const plan = storageChangeReloads({
      [STORAGE_KEYS.BOOKMARK_LINKS]: {},
      [STORAGE_KEYS.API_TOKEN]: {},
      reconcile_lock: {},
    });
    expect(plan.mappings).toBe(false);
    expect(plan.settings).toBe(false);
    expect(plan.stats).toBe(false);
    expect(plan.errors).toBe(false);
  });

  it('reloads nothing for an empty change set', () => {
    const plan = storageChangeReloads({});
    expect(plan).toEqual({ mappings: false, settings: false, stats: false, errors: false });
  });
});
