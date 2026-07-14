import type { EntityPayloadMap, SyncEntity, SyncOperation } from "./entities.js";

export type SyncChange<T extends SyncEntity = SyncEntity> = {
  entity: T;
  op: SyncOperation;
  data: EntityPayloadMap[T];
};

export const cloudSyncProtocolVersion = 1;

export type CloudVersion = {
  putTime: string;
  deviceId: string;
  batchSeq: number;
  opIndex: number;
};

export type CloudSyncConfig = {
  accessKey: string;
  bucket: string;
  region?: string;
  privateDomain: string;
  prefix: "lumora/v1";
  configured: boolean;
};

export type CloudSyncChange = SyncChange & {
  operationId: string;
};

export type CloudSyncBatch = {
  protocolVersion: typeof cloudSyncProtocolVersion;
  deviceId: string;
  batchSeq: number;
  createdAt: string;
  changes: CloudSyncChange[];
};

export type CloudSyncSummary = {
  uploadedChanges: number;
  downloadedChanges: number;
  uploadedFiles: number;
  downloadedFiles: number;
  arxivDownloads: number;
  pendingChanges: number;
  lastSyncedAt: string;
  errors: string[];
  requestCount: number;
  putRequests: number;
  getRequests: number;
  headRequests: number;
  deleteRequests: number;
  uploadedBytes: number;
  downloadedBytes: number;
};

export type ImportJob = {
  id: string;
  provider: "mendeley";
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  error?: string;
  importedPapers: number;
  importedFiles: number;
  importedCollections: number;
};
