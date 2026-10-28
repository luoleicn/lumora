import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { Annotation, LibraryState } from "@lumora/shared";
import { mergeAnnotationCache } from "../lib/annotationCache";
import { enqueueLibraryPersist, flushLibraryPersist, importStateToDb, loadAnnotationsFromDb, loadLibraryFromDb, mergeLibraryReload } from "../lib/libraryDb";
import { createDefaultState, loadLibraryState, saveLibraryState } from "../lib/localStore";

export type UseLibraryStoreOptions = {
  onError: (message: string) => void;
  /** File reconciliation persists its own changes before returning them. */
  reconcile?: (state: LibraryState) => Promise<LibraryState>;
};

/**
 * SQLite owns the complete library; annotations in React are an on-demand
 * cache. Hydration advances only the annotation persistence baseline, so reads
 * never turn untouched rows into local writes or swallow concurrent edits.
 */
export function useLibraryStore({ onError, reconcile }: UseLibraryStoreOptions) {
  const [library, commitLibrary] = useState<LibraryState>(createDefaultState);
  const libraryRef = useRef<LibraryState>(library);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const lastPersistedLibraryRef = useRef<LibraryState | undefined>(undefined);
  const localStorageFallbackRef = useRef(false);
  const annotationScopeRef = useRef<Set<string> | "all">(new Set());
  const pendingAnnotationsRef = useRef(new Map<string, Promise<LibraryState>>());
  const hydratedAnnotationsRef = useRef(new Map<string, Annotation>());
  const generationRef = useRef(0);
  const [annotationGeneration, setAnnotationGeneration] = useState(0);
  const [annotationRevision, setAnnotationRevision] = useState(0);
  const [annotationErrors, setAnnotationErrors] = useState<Record<string, string>>({});
  const initialLoadRef = useRef<Promise<void> | undefined>(undefined);
  const reloadRef = useRef<Promise<boolean> | undefined>(undefined);
  const mountedRef = useRef(true);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  // Keep imperative async consumers in the same order as React updates. Updater
  // functions stay pure and are not executed twice by React StrictMode.
  const setLibrary = useCallback((action: SetStateAction<LibraryState>) => {
    const next = typeof action === "function" ? action(libraryRef.current) : action;
    libraryRef.current = next;
    commitLibrary(next);
  }, []);

  const getAnnotationPaperIds = useCallback(() => (
    annotationScopeRef.current === "all" ? undefined : [...annotationScopeRef.current]
  ), []);

  const withHydratedAnnotations = useCallback((base: LibraryState, current: LibraryState, synced: LibraryState): LibraryState => {
    const refreshedIds = new Set(synced.annotations.map((annotation) => annotation.id));
    return {
      ...base,
      // Let remote updates replace unedited hydrated rows. Rows loaded after
      // the snapshot's scope was captured must remain in the cache as well.
      annotations: mergeAnnotationCache(base.annotations, current.annotations.filter((annotation) => (
        refreshedIds.has(annotation.id) && hydratedAnnotationsRef.current.get(annotation.id) === annotation
      )))
    };
  }, []);

  const areAnnotationsLoaded = useCallback((paperId?: string) => {
    const scope = annotationScopeRef.current;
    return scope === "all" || (paperId !== undefined && scope.has(paperId));
  }, [annotationRevision]);

  const invalidateAnnotationRequests = useCallback(() => {
    generationRef.current += 1;
    pendingAnnotationsRef.current.clear();
    setAnnotationGeneration((generation) => generation + 1);
    setAnnotationErrors({});
  }, []);

  const markPersisted = useCallback((state: LibraryState) => {
    // A paper can have been hydrated while a cloud snapshot was being read.
    // Retain those already-persisted cache rows in the baseline as well.
    const paperIds = new Set(state.papers.map((paper) => paper.id));
    const cached = lastPersistedLibraryRef.current?.annotations.filter((annotation) => paperIds.has(annotation.paperId)) ?? [];
    lastPersistedLibraryRef.current = { ...state, annotations: mergeAnnotationCache(state.annotations, cached) };
    invalidateAnnotationRequests();
  }, [invalidateAnnotationRequests]);

  const ensureAnnotationsLoaded = useCallback((paperId?: string): Promise<LibraryState> => {
    const key = paperId ?? "*";
    const existing = pendingAnnotationsRef.current.get("*") ?? pendingAnnotationsRef.current.get(key);
    if (existing) return existing;
    if (loadedRef.current && (annotationScopeRef.current === "all"
      || (paperId !== undefined && annotationScopeRef.current.has(paperId)))) {
      return Promise.resolve(libraryRef.current);
    }
    const request = (async () => {
      await initialLoadRef.current;
      for (;;) {
        await reloadRef.current?.catch(() => false);
        const generation = generationRef.current;
        if (annotationScopeRef.current === "all"
          || (paperId !== undefined && annotationScopeRef.current.has(paperId))) return libraryRef.current;
        setAnnotationErrors((current) => ({ ...current, [key]: "" }));
        const paperIdsBefore = new Set(libraryRef.current.papers.map((paper) => paper.id));
        let annotations;
        try {
          annotations = await loadAnnotationsFromDb(paperId);
        } catch (error) {
          if (generation !== generationRef.current) continue;
          const message = `Failed to load notes and highlights: ${error}`;
          if (mountedRef.current) {
            setAnnotationErrors((current) => ({ ...current, [key]: message }));
            onErrorRef.current(message);
          }
          throw error;
        }
        if (!mountedRef.current) return libraryRef.current;
        if (generation !== generationRef.current) continue;
        const current = libraryRef.current;
        const paperIdsNow = new Set(current.papers.map((paper) => paper.id));
        annotations = annotations.filter((annotation) => !paperIdsBefore.has(annotation.paperId) || paperIdsNow.has(annotation.paperId));
        const cachedIds = new Set(current.annotations.map((annotation) => annotation.id));
        for (const annotation of annotations) {
          if (!cachedIds.has(annotation.id)) hydratedAnnotationsRef.current.set(annotation.id, annotation);
        }
        const baseline = lastPersistedLibraryRef.current;
        if (baseline) lastPersistedLibraryRef.current = {
          ...baseline,
          annotations: mergeAnnotationCache(baseline.annotations, annotations)
        };
        if (paperId === undefined) annotationScopeRef.current = "all";
        else if (typeof annotationScopeRef.current !== "string") annotationScopeRef.current.add(paperId);
        setAnnotationRevision((revision) => revision + 1);
        const merged = mergeAnnotationCache(current.annotations, annotations);
        if (merged !== current.annotations) setLibrary({ ...current, annotations: merged });
        return libraryRef.current;
      }
    })();
    pendingAnnotationsRef.current.set(key, request);
    const clear = () => {
      if (pendingAnnotationsRef.current.get(key) === request) pendingAnnotationsRef.current.delete(key);
    };
    void request.then(clear, clear);
    return request;
  }, [setLibrary]);

  const adoptFromDb = useCallback((): Promise<boolean> => {
    if (reloadRef.current) return reloadRef.current;
    invalidateAnnotationRequests();
    const reload = (async () => {
      // Queue edits even if React has not yet run its persistence effect.
      const base = libraryRef.current;
      const previous = lastPersistedLibraryRef.current;
      if (previous && previous !== base) {
        lastPersistedLibraryRef.current = base;
        void enqueueLibraryPersist(previous, base, (error) => onErrorRef.current(`Failed to save library: ${error}`));
      }
      await flushLibraryPersist();
      const { state, empty } = await loadLibraryFromDb({ annotationPaperIds: getAnnotationPaperIds() });
      if (empty) return false;
      lastPersistedLibraryRef.current = state;
      setLibrary(mergeLibraryReload(base, state, libraryRef.current));
      return true;
    })();
    reloadRef.current = reload;
    const clear = () => {
      if (reloadRef.current === reload) reloadRef.current = undefined;
      if (mountedRef.current) setAnnotationGeneration((generation) => generation + 1);
    };
    void reload.then(clear, clear);
    return reload;
  }, [getAnnotationPaperIds, invalidateAnnotationRequests, setLibrary]);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    initialLoadRef.current = (async () => {
      try {
        const { state: dbState, empty } = await loadLibraryFromDb({ annotationPaperIds: [] });
        if (cancelled) return;
        if (!empty) {
          lastPersistedLibraryRef.current = dbState;
          loadedRef.current = true;
          setLoaded(true);
          setLibrary(dbState);
          // Disk migration may be slow; it must not block paper annotation
          // queries or replace edits/hydration completed in the meantime.
          void (async () => {
            const reconciled = reconcileRef.current ? await reconcileRef.current(dbState) : dbState;
            if (cancelled || reconciled === dbState) return;
            const current = libraryRef.current;
            const originalFiles = new Map(dbState.fileAssets.map((file) => [file.id, file]));
            const reconciledFiles = new Map(reconciled.fileAssets.map((file) => [file.id, file]));
            const mergeFiles = (files: LibraryState["fileAssets"]) => files.map((file) => (
              file === originalFiles.get(file.id) ? reconciledFiles.get(file.id) ?? file : file
            ));
            const baseline = lastPersistedLibraryRef.current!;
            lastPersistedLibraryRef.current = { ...baseline, fileAssets: mergeFiles(baseline.fileAssets) };
            setLibrary({ ...current, fileAssets: mergeFiles(current.fileAssets) });
          })().catch((error) => {
            if (!cancelled) onErrorRef.current(`Failed to reconcile file storage: ${error}`);
          });
          return;
        }
        const legacyState = loadLibraryState();
        await importStateToDb(legacyState);
        if (cancelled) return;
        annotationScopeRef.current = legacyState.annotations.length ? "all" : new Set();
        lastPersistedLibraryRef.current = legacyState;
        loadedRef.current = true;
        setLoaded(true);
        setLibrary(legacyState);
      } catch (error) {
        if (cancelled) return;
        localStorageFallbackRef.current = true;
        annotationScopeRef.current = "all";
        setLibrary(loadLibraryState());
        setLoaded(true);
        onErrorRef.current(`Library database unavailable, falling back to browser storage: ${error}`);
      }
    })();
    return () => { cancelled = true; mountedRef.current = false; };
  }, [setLibrary]);

  useEffect(() => {
    if (library !== libraryRef.current) return;
    if (!loadedRef.current) {
      if (localStorageFallbackRef.current) saveLibraryState(library);
      return;
    }
    const previous = lastPersistedLibraryRef.current;
    if (!previous || previous === library) return;
    lastPersistedLibraryRef.current = library;
    void enqueueLibraryPersist(previous, library, (error) => onErrorRef.current(`Failed to save library: ${error}`));
  }, [library]);

  return {
    library, setLibrary, libraryRef, loadedRef, loaded, markPersisted, adoptFromDb,
    ensureAnnotationsLoaded, areAnnotationsLoaded, getAnnotationPaperIds, withHydratedAnnotations,
    annotationGeneration, annotationErrors
  };
}

export type LibraryStore = ReturnType<typeof useLibraryStore>;
