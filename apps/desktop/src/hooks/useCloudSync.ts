import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LibrarySyncActivity } from "../components/LibrarySidebar";
import { formatActionError } from "../lib/actionError";
import { formatFileSize } from "../lib/arxivFiles";
import { mergeBackgroundSyncState } from "../lib/mendeleyClient";
import {
  defaultSyncSettings,
  loadAutoSyncSettings,
  loadSyncConfig,
  saveAutoSyncSettings,
  saveSyncConfig,
  syncLibrary,
  testSyncConnection,
  type AutoSyncSettings,
  type SyncSettings
} from "../lib/syncClient";
import type { LibraryStore } from "./useLibraryStore";

export type UseCloudSyncOptions = {
  store: LibraryStore;
  onStatus: (message: string | undefined) => void;
  /** Invoked when a sync is requested before the bucket is configured. */
  onRequireConfiguration: () => void;
};

/**
 * Qiniu object-storage sync orchestration: config load/save, the periodic
 * background sync, live stage progress, and reconciling the Rust sync result
 * with edits made while it ran.
 */
export function useCloudSync({ store, onStatus, onRequireConfiguration }: UseCloudSyncOptions) {
  const [settings, setSettings] = useState<SyncSettings>(defaultSyncSettings);
  // Kept separate from any global busy flag so the background periodic sync
  // never leaves the Sync Settings modal stuck showing "Working…".
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [autoSyncSettings, setAutoSyncSettings] = useState<AutoSyncSettings>(() => loadAutoSyncSettings());
  const [activity, setActivity] = useState<LibrarySyncActivity>();
  const inFlightRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onRequireConfigurationRef = useRef(onRequireConfiguration);
  onRequireConfigurationRef.current = onRequireConfiguration;

  useEffect(() => {
    void loadSyncConfig()
      .then(setSettings)
      .catch((error) => onStatusRef.current(`Failed to load Qiniu settings: ${error}`));
  }, []);

  // Live progress emitted from the Rust cloud-sync command so the user can see
  // which stage a long background sync is at instead of a single opaque spinner.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("qiniu-sync-stage", (event) => {
      if (inFlightRef.current) {
        setActivity((current) => current ? { ...current, message: event.payload } : current);
      }
    }).then((next) => {
      unlisten = next;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    saveAutoSyncSettings(autoSyncSettings);
  }, [autoSyncSettings]);

  // Cloud sync runs in the background: it never sets a global busy flag, so the
  // user can keep working while a live progress indicator tracks each stage.
  async function sync() {
    if (inFlightRef.current) return;
    if (!settings.configured) {
      onRequireConfigurationRef.current();
      return;
    }
    const syncStartedAt = new Date().toISOString();
    const baseState = store.libraryRef.current ?? store.library;
    inFlightRef.current = true;
    cancelRequestedRef.current = false;
    setActivity({ state: "running", message: "Starting sync…", completed: 0, total: 5 });
    try {
      const result = await syncLibrary(
        settings,
        baseState,
        (message, completed = 0, total = 5) =>
          setActivity({ state: "running", message, completed, total })
      );
      if (cancelRequestedRef.current) return;
      // syncLibrary reloads its result from SQLite, so every entity has a new
      // object identity even when its content did not change. Treat that state
      // as the persisted baseline before publishing it to React; otherwise the
      // reference-based persistence diff marks the entire library local again.
      // Merge on top any edits made while the background sync was in flight.
      store.markPersisted(result.state);
      store.setLibrary((current) => mergeBackgroundSyncState(baseState, result.state, current, syncStartedAt));
      setActivity({
        state: "success",
        message: `${result.summary.uploadedChanges} changes uploaded, ${result.summary.downloadedChanges} downloaded · `
          + `${formatFileSize(result.summary.uploadedBytes)} PUT, ${formatFileSize(result.summary.downloadedBytes)} GET · `
          + `${result.summary.requestCount} requests (`
          + `${result.summary.putRequests} PUT/${result.summary.getRequests} GET/`
          + `${result.summary.headRequests} HEAD/${result.summary.deleteRequests} DELETE)`,
        completed: 5,
        total: 5
      });
    } catch (error) {
      if (cancelRequestedRef.current) return;
      // Metadata (papers, collections, membership) is committed to the DB during
      // the pull phase, before file blobs are fetched. When a later stage throws,
      // the returned state never reaches setLibrary, leaving the sidebar stale
      // until a manual refresh. Reload from the DB so everything that did land is
      // reflected immediately; keep the original sync error if the reload fails.
      try {
        await store.adoptFromDb();
      } catch {
        // Ignore — surface the original sync failure below.
      }
      setActivity({ state: "error", message: formatActionError(error), completed: 0, total: 5 });
    } finally {
      inFlightRef.current = false;
    }
  }

  // The timer effect reads the latest closure through a ref so a rescheduled
  // interval is only needed when the scheduling inputs themselves change.
  const syncRef = useRef(sync);
  syncRef.current = sync;

  // Object-storage sync is intentionally periodic rather than edit-debounced:
  // one run after startup, then once per configured interval while the app
  // remains open. The user can disable it or change the interval in Sync Settings.
  useEffect(() => {
    if (!settings.configured || !autoSyncSettings.enabled) return;
    const initial = window.setTimeout(() => void syncRef.current(), 1_000);
    const timer = window.setInterval(() => void syncRef.current(), autoSyncSettings.intervalMinutes * 60 * 1_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [settings.configured, settings.bucket, settings.accessKey, autoSyncSettings.enabled, autoSyncSettings.intervalMinutes]);

  async function saveSettings(nextSettings: SyncSettings) {
    setSettingsBusy(true);
    onStatusRef.current(undefined);
    try {
      const saved = await saveSyncConfig(nextSettings);
      setSettings({ ...saved, secretKey: undefined });
      await testSyncConnection();
      onStatusRef.current("Qiniu private bucket configured.");
    } catch (error) {
      onStatusRef.current(formatActionError(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  // When the cloud sync is still running, clicking X requests cancellation and
  // dismisses the card immediately — the backend finishes in the background but
  // the result is silently discarded.
  function cancelSync() {
    cancelRequestedRef.current = true;
    setActivity(undefined);
  }

  // When the cloud sync has already settled (success / error), clicking X
  // simply removes the card.
  function dismissActivity() {
    setActivity(undefined);
  }

  return {
    settings,
    settingsBusy,
    autoSyncSettings,
    setAutoSyncSettings,
    activity,
    sync,
    saveSettings,
    cancelSync,
    dismissActivity
  };
}
