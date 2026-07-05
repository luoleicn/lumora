import type { EntityPayloadMap, SyncEntity, SyncOperation } from "./entities.js";

export type SyncChange<T extends SyncEntity = SyncEntity> = {
  entity: T;
  op: SyncOperation;
  data: EntityPayloadMap[T];
};

export type SyncPushRequest = {
  clientId: string;
  changes: SyncChange[];
};

export type SyncPushResponse = {
  accepted: number;
  serverCursor: number;
};

export type SyncPullResponse = {
  cursor: number;
  changes: SyncChange[];
};

export type LoginRequest = {
  email: string;
  password: string;
};

export type LoginResponse = {
  accessToken: string;
  expiresAt: string;
};

export type InitUploadRequest = {
  fileAssetId: string;
  paperId: string;
  sha256: string;
  size: number;
  mime: string;
  fileName: string;
};

export type InitUploadResponse = {
  fileAssetId: string;
  objectKey: string;
  uploadUrl: string;
};

export type DownloadUrlResponse = {
  url: string;
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
