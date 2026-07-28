// Pure helpers over the Raindrop collections cache.

import type { Collection } from '../types/raindrop';

/**
 * Direct child collections of `collectionId` from a prefetched cache
 * (task 001). Root collections have `parent: null` and are never
 * anyone's children.
 */
export function getChildCollectionsOf(
  collectionId: number,
  cache: Collection[]
): Collection[] {
  return cache.filter((c) => c.parent?.$id === collectionId);
}
