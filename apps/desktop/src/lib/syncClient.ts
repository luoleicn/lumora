import type {
  Annotation,
  ArxivMetadata,
  Collection,
  FileAsset,
  InitUploadRequest,
  LibraryState,
  LoginResponse,
  Paper,
  PaperCollection,
  SyncChange,
  SyncPullResponse,
  SyncPushResponse
} from "@lumora/shared";
import { getClientId, getFileBlob, upsertById } from "./localStore";

export type SyncSettings = {
  serverUrl: string;
  email: string;
  password: string;
  token?: string;
};

export async function login(settings: SyncSettings): Promise<LoginResponse> {
  const response = await fetch(`${settings.serverUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: settings.email, password: settings.password })
  });

  if (!response.ok) {
    throw new Error("Login failed");
  }

  return response.json() as Promise<LoginResponse>;
}

export async function syncLibrary(settings: SyncSettings, state: LibraryState): Promise<LibraryState> {
  if (!settings.token) {
    throw new Error("Login before syncing.");
  }

  const uploadedState = await uploadLocalFiles(settings, state);
  const pushResponse = await pushChanges(settings, uploadedState);
  const pullResponse = await pullChanges(settings, uploadedState.lastSyncCursor ?? 0);
  const merged = applyRemoteChanges(uploadedState, pullResponse);

  return {
    ...merged,
    lastSyncCursor: Math.max(pushResponse.serverCursor, pullResponse.cursor)
  };
}

export function mendeleyOAuthUrl(settings: SyncSettings) {
  if (!settings.token) {
    throw new Error("Login before connecting Mendeley.");
  }

  const url = new URL(`${settings.serverUrl}/mendeley/oauth/start`);
  url.searchParams.set("token", settings.token);
  return url.toString();
}

export async function startMendeleyImport(settings: SyncSettings) {
  if (!settings.token) {
    throw new Error("Login before importing from Mendeley.");
  }

  const response = await fetch(`${settings.serverUrl}/imports/mendeley`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.token}`
    }
  });

  if (!response.ok) {
    throw new Error("Failed to start Mendeley import");
  }

  return response.json();
}

export async function searchArxivMetadata(settings: SyncSettings, title: string): Promise<ArxivMetadata[]> {
  const url = new URL(`${settings.serverUrl}/metadata/arxiv`);
  url.searchParams.set("title", title);
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(body?.error ?? "arXiv lookup failed");
  }

  const data = await response.json() as { results: ArxivMetadata[] };
  return data.results;
}

async function pushChanges(settings: SyncSettings, state: LibraryState): Promise<SyncPushResponse> {
  const changes: SyncChange[] = [
    ...state.papers.map((data) => ({ entity: "paper" as const, op: data.deletedAt ? "delete" as const : "upsert" as const, data })),
    ...state.fileAssets.map((data) => ({ entity: "fileAsset" as const, op: data.deletedAt ? "delete" as const : "upsert" as const, data })),
    ...state.collections.map((data) => ({ entity: "collection" as const, op: data.deletedAt ? "delete" as const : "upsert" as const, data })),
    ...state.paperCollections.map((data) => ({ entity: "paperCollection" as const, op: data.deletedAt ? "delete" as const : "upsert" as const, data })),
    ...state.annotations.map((data) => ({ entity: "annotation" as const, op: data.deletedAt ? "delete" as const : "upsert" as const, data }))
  ];

  const response = await fetch(`${settings.serverUrl}/sync/push`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.token}`
    },
    body: JSON.stringify({
      clientId: getClientId(),
      changes
    })
  });

  if (!response.ok) {
    throw new Error("Sync push failed");
  }

  return response.json() as Promise<SyncPushResponse>;
}

async function pullChanges(settings: SyncSettings, cursor: number): Promise<SyncPullResponse> {
  const response = await fetch(`${settings.serverUrl}/sync/pull?cursor=${cursor}`, {
    headers: {
      authorization: `Bearer ${settings.token}`
    }
  });

  if (!response.ok) {
    throw new Error("Sync pull failed");
  }

  return response.json() as Promise<SyncPullResponse>;
}

function applyRemoteChanges(state: LibraryState, response: SyncPullResponse): LibraryState {
  let next = { ...state };

  for (const change of response.changes) {
    switch (change.entity) {
      case "paper":
        next = { ...next, papers: upsertById(next.papers, change.data as Paper) };
        break;
      case "fileAsset":
        next = { ...next, fileAssets: upsertById(next.fileAssets, change.data as FileAsset) };
        break;
      case "collection":
        next = { ...next, collections: upsertById(next.collections, change.data as Collection) };
        break;
      case "paperCollection":
        next = { ...next, paperCollections: upsertById(next.paperCollections, change.data as PaperCollection) };
        break;
      case "annotation":
        next = { ...next, annotations: upsertById(next.annotations, change.data as Annotation) };
        break;
    }
  }

  return next;
}

async function uploadLocalFiles(settings: SyncSettings, state: LibraryState): Promise<LibraryState> {
  const nextFileAssets: FileAsset[] = [];

  for (const fileAsset of state.fileAssets) {
    if (fileAsset.deletedAt || fileAsset.objectKey) {
      nextFileAssets.push(fileAsset);
      continue;
    }

    const blob = await getFileBlob(fileAsset.id);
    if (!blob) {
      nextFileAssets.push(fileAsset);
      continue;
    }

    const request: InitUploadRequest = {
      fileAssetId: fileAsset.id,
      paperId: fileAsset.paperId,
      sha256: fileAsset.sha256,
      size: fileAsset.size,
      mime: fileAsset.mime,
      fileName: fileAsset.fileName
    };

    const initResponse = await fetch(`${settings.serverUrl}/files/init-upload`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.token}`
      },
      body: JSON.stringify(request)
    });

    if (!initResponse.ok) {
      throw new Error(`Upload initialization failed for ${fileAsset.fileName}`);
    }

    const { uploadUrl, objectKey } = await initResponse.json() as { uploadUrl: string; objectKey: string };
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": fileAsset.mime
      },
      body: blob
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed for ${fileAsset.fileName}`);
    }

    nextFileAssets.push({
      ...fileAsset,
      objectKey,
      downloadState: "remote",
      updatedAt: new Date().toISOString()
    });
  }

  return {
    ...state,
    fileAssets: nextFileAssets
  };
}
