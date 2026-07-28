// Three-way reconcile decisions (task 014). Pure — no IO, no browser API.
//
// baseline = what both sides looked like after the last successful sync:
//   bookmark → BookmarkLink.contentHash + BookmarkLink.mappingId
//   folder   → FolderMapping.folderName
// Each side is compared against the baseline; the side that changed wins its
// direction. Both changed → conflict → Raindrop wins. No baseline is handled
// by the caller (create/adopt, never delete).

export interface BookmarkSnapshot {
  /** computeBookmarkHash / computeRaindropHash over url+title */
  hash: string;
  /** FolderMapping.id of the folder/collection the object currently lives in */
  mappingId: string;
}

export type BookmarkAction =
  | 'none'
  | 'push-update' // browser → Raindrop (content and/or collection move)
  | 'pull-update' // Raindrop → browser (content/move; caller recreates if browser side is gone)
  | 'delete-in-raindrop' // deleted in browser, Raindrop untouched since baseline
  | 'delete-in-browser' // deleted in Raindrop → Raindrop wins even against a browser edit
  | 'drop-link'; // gone on both sides — forget the link

export function decideBookmarkAction(
  base: BookmarkSnapshot,
  browserSide: BookmarkSnapshot | null,
  raindropSide: BookmarkSnapshot | null
): BookmarkAction {
  const changed = (s: BookmarkSnapshot): boolean =>
    s.hash !== base.hash || s.mappingId !== base.mappingId;

  if (browserSide && raindropSide) {
    const b = changed(browserSide);
    const r = changed(raindropSide);
    if (!b && !r) return 'none';
    if (b && !r) return 'push-update';
    return 'pull-update'; // r alone, or both changed (conflict → Raindrop wins)
  }
  if (!browserSide && raindropSide) {
    // Deleted in the browser. An untouched raindrop follows the deletion; an
    // edited one is a delete-vs-edit conflict → Raindrop wins → resurrect.
    return changed(raindropSide) ? 'pull-update' : 'delete-in-raindrop';
  }
  if (browserSide && !raindropSide) {
    // Deleted in Raindrop → Raindrop wins, even if the browser copy was edited.
    return 'delete-in-browser';
  }
  return 'drop-link';
}

// Name comparison for folder↔collection sync: case-insensitive, trimmed
// (grilling decision #1). Case/whitespace drift is not a rename.
export function namesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type RenameAction = 'none' | 'push-rename' | 'pull-rename';

export function decideRenameAction(
  baseName: string,
  browserName: string,
  raindropName: string
): RenameAction {
  if (!namesMatch(raindropName, baseName)) return 'pull-rename'; // alone or conflict → Raindrop wins
  if (!namesMatch(browserName, baseName)) return 'push-rename';
  return 'none';
}
