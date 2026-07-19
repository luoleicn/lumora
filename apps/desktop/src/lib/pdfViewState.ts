export type PdfViewState = {
  scrollTop: number;
  zoom?: number;
};

type PdfExitViewStateInput = {
  pendingViewState?: PdfViewState;
  currentScrollTop?: number;
  restoredScrollTop?: number;
  pendingZoom?: number;
  currentZoom: number;
  hasExplicitZoom: boolean;
};

/** Selects the freshest reader values when the page exits mid-debounce. */
export function resolvePdfExitViewState({
  pendingViewState,
  currentScrollTop,
  restoredScrollTop,
  pendingZoom,
  currentZoom,
  hasExplicitZoom
}: PdfExitViewStateInput): PdfViewState {
  return {
    scrollTop: pendingViewState?.scrollTop ?? currentScrollTop ?? restoredScrollTop ?? 0,
    zoom: hasExplicitZoom ? pendingZoom ?? currentZoom : undefined
  };
}
