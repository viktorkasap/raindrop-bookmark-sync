import { describe, it, expect } from 'vitest';
import type { Collection } from '../types/raindrop';
import { getChildCollectionsOf } from './collections';

function collection(partial: Partial<Collection> & { _id: number }): Collection {
  return { title: `c${partial._id}`, parent: null, ...partial } as Collection;
}

// Tree: 1 (root) → 2, 3; 2 → 4; 10 (root, childless)
const cache: Collection[] = [
  collection({ _id: 1 }),
  collection({ _id: 2, parent: { $id: 1 } }),
  collection({ _id: 3, parent: { $id: 1 } }),
  collection({ _id: 4, parent: { $id: 2 } }),
  collection({ _id: 10 }),
];

describe('getChildCollectionsOf', () => {
  it('returns direct children only (no grandchildren)', () => {
    const ids = getChildCollectionsOf(1, cache).map((c) => c._id);
    expect(ids.sort()).toEqual([2, 3]);
  });

  it('returns empty array for a childless collection', () => {
    expect(getChildCollectionsOf(10, cache)).toEqual([]);
  });

  it('returns empty array for an unknown collection id', () => {
    expect(getChildCollectionsOf(999, cache)).toEqual([]);
  });

  it('does not treat root collections (parent: null) as children of anything', () => {
    // Guards against sloppy `c.parent?.$id == id` matching with undefined/null ids.
    const allChildren = cache.flatMap((c) => getChildCollectionsOf(c._id, cache));
    expect(allChildren.map((c) => c._id)).not.toContain(1);
    expect(allChildren.map((c) => c._id)).not.toContain(10);
  });
});
