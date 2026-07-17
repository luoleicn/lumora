import { useEffect, useRef, useState } from "react";
import type { LibrarySyncActivity } from "../components/LibrarySidebar";
import { formatActionError } from "../lib/actionError";
import type { FileStorageSettings } from "../lib/fileStorage";
import {
  connectMendeley,
  disconnectMendeley,
  getMendeleyConnection,
  loadMendeleySettings,
  mergeBackgroundSyncState,
  saveMendeleySettings,
  syncWithMendeley,
  MendeleySyncCancelledError,
  type MendeleyConnection,
  type MendeleySyncProgress,
  type MendeleySettings
} from "../lib/mendeleyClient";
import type { LibraryStore } from "./useLibraryStore";

export type UseMendeleySyncOptions = {
  store: LibraryStore;
  fileStorageSettings: FileStorageSettings;
  onStatus: (message: string | undefined) => void;
};

/**
 * Mendeley OAuth connection and incremental sync orchestration. Unlike the
 * cloud sync, Mendeley results are persisted through the regular library
 * diff — the sync merges into React state and the store writes the changes.
 */
export function useMendeleySync({ store, fileStorageSettings, onStatus }: UseMendeleySyncOptions) {
  const [settings, setSettings] = useState<MendeleySettings>(() => loadMendeleySettings());
  const [connection, setConnection] = useState<MendeleyConnection>();
  /** Guards connect/disconnect round-trips (the modal's Connect buttons). */
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [activity, setActivity] = useState<LibrarySyncActivity>();
  const cancelRequestedRef = useRef(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    saveMendeleySettings(settings);
  }, [settings]);

  async function refreshConnection() {
    await getMendeleyConnection()
      .then(setConnection)
      .catch(() => setConnection(undefined));
  }

  async function connect() {
    setConnectionBusy(true);
    onStatusRef.current("Waiting for Mendeley authorization in the browser...");
    try {
      const nextConnection = await connectMendeley(settings);
      setConnection(nextConnection);
      onStatusRef.current(nextConnection.displayName
        ? `Connected to Mendeley as ${nextConnection.displayName}.`
        : "Connected to Mendeley.");
    } catch (error) {
      onStatusRef.current(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(false);
    }
  }

  async function disconnect() {
    setConnectionBusy(true);
    onStatusRef.current(undefined);
    try {
      await disconnectMendeley();
      setConnection({ connected: false });
      onStatusRef.current("Disconnected from Mendeley.");
    } catch (error) {
      onStatusRef.current(formatActionError(error));
    } finally {
      setConnectionBusy(false);
    }
  }

  async function sync() {
    if (syncBusy) {
      return;
    }
    const syncStartedAt = new Date().toISOString();
    const baseState = store.libraryRef.current ?? store.library;
    let mergeBaseState = baseState;
    cancelRequestedRef.current = false;
    setSyncBusy(true);
    setActivity({ state: "running", message: "Starting Mendeley sync…", completed: 0, total: 8 });
    onStatusRef.current("Syncing with Mendeley...");
    try {
      const { state: nextState, summary } = await syncWithMendeley(
        baseState,
        settings,
        fileStorageSettings,
        (progress: MendeleySyncProgress) => {
          setActivity({
            state: "running",
            message: progress.message,
            completed: progress.completed,
            total: progress.total
          });
        },
        {
          isCancelled: () => cancelRequestedRef.current,
          onStateUpdate: (partialState) => {
            const previousMergeBase = mergeBaseState;
            mergeBaseState = partialState;
            store.setLibrary((current) => mergeBackgroundSyncState(previousMergeBase, partialState, current, syncStartedAt));
          }
        }
      );
      store.setLibrary((current) => mergeBackgroundSyncState(mergeBaseState, nextState, current, syncStartedAt));
      const completionMessage =
        `Mendeley sync complete: ${summary.pulled} pulled, ${summary.pushed} pushed, `
        + `${summary.folders} folders, ${summary.folderLinks} folder links, ${summary.files} files, `
        + `${summary.annotations} annotations; ${summary.deletedLocally} deleted locally, `
        + `${summary.deletedRemotely} deleted remotely.`
        + (summary.unavailableResources.length
          ? ` Mendeley did not expose: ${summary.unavailableResources.join(", ")}.`
          : "");
      onStatusRef.current(completionMessage);
      setActivity({
        state: "success",
        message: `${summary.pulled} papers, ${summary.folders} folders, ${summary.files} files, ${summary.annotations} annotations`,
        completed: 8,
        total: 8
      });
    } catch (error) {
      if (error instanceof MendeleySyncCancelledError) {
        onStatusRef.current("Mendeley sync cancelled.");
        setActivity((current) => ({
          state: "cancelled",
          message: "Sync cancelled",
          completed: current?.completed ?? 0,
          total: current?.total ?? 8
        }));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      onStatusRef.current(message);
      setActivity({ state: "error", message, completed: 0, total: 8 });
    } finally {
      setSyncBusy(false);
    }
  }

  function cancelSync() {
    if (!syncBusy) return;
    cancelRequestedRef.current = true;
    setActivity((current) => current ? {
      ...current,
      message: "Cancelling after the current request…"
    } : current);
  }

  return {
    settings,
    setSettings,
    connection,
    connectionBusy,
    syncBusy,
    activity,
    refreshConnection,
    connect,
    disconnect,
    sync,
    cancelSync
  };
}
