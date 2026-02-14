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
  syncChildren: boolean; // whether to sync nested folders
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

export interface SyncQueue {
  pending: SyncOperation[];
  failed: SyncOperation[];
}

export interface SyncOperation {
  id: string;
  type: 'create' | 'update' | 'delete' | 'move';
  source: 'firefox' | 'raindrop';
  entityType: 'bookmark' | 'folder';
  data: SyncOperationData;
  timestamp: number;
  retries: number;
  maxRetries: number;
  lastError?: string;
}

export interface SyncOperationData {
  firefoxId?: string;
  raindropId?: number;
  url?: string;
  title?: string;
  collectionId?: number;
  parentFolderId?: string;
  oldCollectionId?: number;
  newCollectionId?: number;
  mappingId?: string;
}

export interface SyncStats {
  totalSynced: number;
  pendingOperations: number;
  failedOperations: number;
  lastSyncTime: number;
  lastSyncStatus: 'success' | 'partial' | 'failed' | 'never';
  errors: SyncError[];
}

export interface SyncError {
  timestamp: number;
  operation: string;
  message: string;
  details?: string;
}


// Storage keys
export const STORAGE_KEYS = {
  API_TOKEN: 'api_token',
  SYNC_SETTINGS: 'sync_settings',
  FOLDER_MAPPINGS: 'folder_mappings',
  BOOKMARK_LINKS: 'bookmark_links',
  SYNC_QUEUE: 'sync_queue',
  SYNC_STATS: 'sync_stats',
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
  pendingOperations: 0,
  failedOperations: 0,
  lastSyncTime: 0,
  lastSyncStatus: 'never',
  errors: [],
};

export const DEFAULT_SYNC_QUEUE: SyncQueue = {
  pending: [],
  failed: [],
};
