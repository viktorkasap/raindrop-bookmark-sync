// Storage Types for the extension

export interface ApiToken {
  testToken: string;
}

export interface SyncSettings {
  enabled: boolean;
  syncInterval: number; // minutes (default: 5)
  lastFullSync: number; // timestamp
  debugMode: boolean;
}

export interface FolderMapping {
  id: string; // unique mapping ID
  firefoxFolderId: string;
  raindropCollectionId: number;
  folderName: string;
  raindropCollectionName: string;
  parentMappingId?: string; // for nested folders
  depth: number; // nesting level
  lastSync: number; // timestamp
}

export interface BookmarkLink {
  id: string; // unique link ID
  firefoxId: string;
  raindropId: number;
  url: string;
  title: string;
  lastModified: number; // timestamp
  contentHash: string; // for change detection
  syncStatus: 'synced' | 'pending' | 'conflict' | 'error';
  mappingId: string; // reference to FolderMapping
  errorMessage?: string;
}

export interface SyncStats {
  totalSynced: number;
  lastSyncTime: number;
  lastSyncStatus: 'success' | 'partial' | 'failed' | 'never';
}

// Which reconcile operation an error came from (task 015). Closed set so a
// typo can't ship and the UI can rely on the values.
export type SyncErrorType =
  | 'folder' // syncing the folder ↔ collection tree
  | 'fetch' // reading a collection's raindrops
  | 'sync' // reconciling a linked bookmark (push/pull/delete)
  | 'create' // creating a bookmark or raindrop
  | 'connection'; // the whole pass aborted (offline / server down / bad token)

// One error from the last reconcile pass, shown in the Options errors panel as
// "type — message". `message` is the human-readable description. Replaced
// wholesale each pass, so the panel only ever shows the current state.
export interface SyncErrorEntry {
  type: SyncErrorType;
  message: string;
}

// Storage keys
export const STORAGE_KEYS = {
  API_TOKEN: 'api_token',
  SYNC_SETTINGS: 'sync_settings',
  FOLDER_MAPPINGS: 'folder_mappings',
  BOOKMARK_LINKS: 'bookmark_links',
  SYNC_STATS: 'sync_stats',
  SYNC_ERRORS: 'sync_errors',
} as const;

// Default values
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  enabled: false,
  syncInterval: 5,
  lastFullSync: 0,
  debugMode: false,
};

export const DEFAULT_SYNC_STATS: SyncStats = {
  totalSynced: 0,
  lastSyncTime: 0,
  lastSyncStatus: 'never',
};
