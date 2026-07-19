import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryState } from "@lumora/shared";
import { enqueueLibraryPersist, importStateToDb, loadLibraryFromDb } from "../lib/libraryDb";
import { loadLibraryState, saveLibraryState } from "../lib/localStore";

export type UseLibraryStoreOptions = {
  /** Receives user-facing persistence failures (unavailable DB, failed saves). */
  onError: (message: string) => void;
  /**
   * Runs once against the freshly loaded DB state (file-storage
   * reconciliation). Must persist its own changes and return the input state
   * unchanged when nothing needed fixing.
   */
  reconcile?: (state: LibraryState) => Promise<LibraryState>;
};

/**
 * Owns the whole-library in-memory state and its persistence contract: every
 * mutation must be an immutable update through `setLibrary`, and a reference
 * diff against the last persisted state decides which entities are written to
 * SQLite. States that are already persisted (sync results, DB reloads) must be
 * announced via `markPersisted`/`adoptFromDb` so the diff never re-marks the
 * whole library as locally dirty.
 */
export function useLibraryStore({ onError, reconcile }: UseLibraryStoreOptions) {
  const [library, setLibrary] = useState<LibraryState>(() => loadLibraryState());
  const [loaded, setLoaded] = useState(false);
  const libraryRef = useRef<LibraryState | undefined>(undefined);
  const lastPersistedLibraryRef = useRef<LibraryState | undefined>(undefined);
  const loadedRef = useRef(false);
  const localStorageFallbackRef = useRef(false);
  // Read through refs so the mount-time load effect always sees the latest
  // callbacks without re-running.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  useEffect(() => {
    libraryRef.current = library;
  }, [library]);

  /**
   * Adopt a state as the persistence baseline without writing it: use for
   * states whose entities already live in SQLite (e.g. a cloud-sync result).
   * A following `setLibrary` then only persists what differs from it.
   */
  const markPersisted = useCallback((state: LibraryState) => {
    lastPersistedLibraryRef.current = state;
  }, []);

  /**
   * Reload the library from SQLite and adopt it as both the React state and
   * the persistence baseline. Returns false when the database is empty.
   */
  const adoptFromDb = useCallback(async (): Promise<boolean> => {
    const { state, empty } = await loadLibraryFromDb();
    if (empty) {
      return false;
    }
    lastPersistedLibraryRef.current = state;
    setLibrary(state);
    return true;
  }, []);

  // Startup: SQLite is the source of truth. When it is empty this is a first
  // run on the new storage layer, so the legacy localStorage state (already in
  // React state) is imported once; localStorage is kept untouched as a backup
  // but never written again.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { state: dbState, empty } = await loadLibraryFromDb();
        if (cancelled) {
          return;
        }

        if (!empty) {
          lastPersistedLibraryRef.current = dbState;
          loadedRef.current = true;
          setLoaded(true);
          setLibrary(dbState);
          // Reconcile records against the storage folder: drain any leftover
          // IndexedDB blobs to disk, re-link PDFs that lost their localPath, and
          // clear stale local flags. reconcile persists its own changes, so
          // advance the baseline to avoid a redundant full re-diff.
          const reconciled = reconcileRef.current ? await reconcileRef.current(dbState) : dbState;
          if (cancelled || reconciled === dbState) {
            return;
          }
          lastPersistedLibraryRef.current = reconciled;
          setLibrary(reconciled);
          return;
        }

        const legacyState = libraryRef.current ?? library;
        await importStateToDb(legacyState);
        if (cancelled) {
          return;
        }
        lastPersistedLibraryRef.current = legacyState;
        loadedRef.current = true;
        setLoaded(true);
      } catch (error) {
        // Without a working database, fall back to the legacy localStorage
        // persistence for this session rather than silently losing edits.
        localStorageFallbackRef.current = true;
        setLoaded(true);
        onErrorRef.current(`Library database unavailable, falling back to browser storage: ${error}`);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loadedRef.current) {
      if (localStorageFallbackRef.current) {
        saveLibraryState(library);
      }
      return;
    }

    const previous = lastPersistedLibraryRef.current;
    if (!previous || previous === library) {
      return;
    }

    lastPersistedLibraryRef.current = library;
    void enqueueLibraryPersist(previous, library, (error) => {
      onErrorRef.current(`Failed to save library: ${error}`);
    });
  }, [library]);

  return {
    library,
    setLibrary,
    /** Latest committed library state for async flows that outlive a render. */
    libraryRef,
    /** True once SQLite finished loading; persistence is inert before that. */
    loadedRef,
    /** True once startup selected SQLite or the browser-storage fallback. */
    loaded,
    markPersisted,
    adoptFromDb
  };
}

export type LibraryStore = ReturnType<typeof useLibraryStore>;
