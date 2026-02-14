// Shared message types for communication between background, popup, and options

export interface MessageRequest {
  action: string;
  data?: unknown;
}

export interface MessageResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface SyncStatus {
  isAuthenticated: boolean;
  isEnabled: boolean;
  isSyncing: boolean;
  mappingsCount: number;
  linksCount: number;
  lastSyncTime: number;
  lastSyncStatus: string;
  pendingOperations: number;
  userName?: string;
}
