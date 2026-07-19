import { describe, expect, it } from "vitest";
import { resolvePdfExitViewState } from "./pdfViewState";

describe("resolvePdfExitViewState", () => {
  it("prefers scroll and zoom values that are still pending when the app exits", () => {
    expect(resolvePdfExitViewState({
      pendingViewState: { scrollTop: 840, zoom: 1.1 },
      currentScrollTop: 800,
      restoredScrollTop: 120,
      pendingZoom: 1.5,
      currentZoom: 1.25,
      hasExplicitZoom: true
    })).toEqual({ scrollTop: 840, zoom: 1.5 });
  });

  it("uses the live reader position and keeps fit-width zoom implicit", () => {
    expect(resolvePdfExitViewState({
      currentScrollTop: 360,
      restoredScrollTop: 120,
      currentZoom: 0.9,
      hasExplicitZoom: false
    })).toEqual({ scrollTop: 360, zoom: undefined });
  });
});
