// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultSyncSettings } from "../lib/syncClient";
import { SyncPanel } from "./SyncPanel";

describe("SyncPanel", () => {
  it("shows loading and retry states before reporting an empty paper's notes", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const onRetry = vi.fn();
    const props = {
      settings: defaultSyncSettings,
      paper: { id: "p1", title: "Paper", authors: [], createdAt: "now", updatedAt: "now" },
      selectedPaperCount: 1, onRequestFileData: async () => undefined, hasLocalPdf: false,
      annotations: [], fileStorageSettings: { nameTemplate: "{title}" },
      onUpdatePaper: vi.fn(), arxivDownloadBusy: false, onDownloadArxiv: async () => "", onDeleteAnnotation: vi.fn(),
      onRetryAnnotations: onRetry
    };
    try {
      act(() => root.render(<SyncPanel {...props} annotationsLoaded={false} />));
      act(() => (host.querySelectorAll(".inspector-tabs button")[1] as HTMLButtonElement).click());
      expect(host.textContent).toContain("Loading notes and highlights");
      expect(host.textContent).not.toContain("No notes or highlights");
      act(() => root.render(<SyncPanel {...props} annotationsLoaded={false} annotationError="Read failed" />));
      expect(host.textContent).toContain("Unable to load notes and highlights");
      act(() => (host.querySelector(".annotation-load-status button") as HTMLButtonElement).click());
      expect(onRetry).toHaveBeenCalledTimes(1);
      act(() => root.render(<SyncPanel {...props} annotationsLoaded />));
      expect(host.textContent).toContain("No notes or highlights for this document");
    } finally {
      act(() => root.unmount()); host.remove();
    }
  });

  it("shows the number of selected documents instead of editable single-paper details", () => {
    const markup = renderToStaticMarkup(
      <SyncPanel
        settings={defaultSyncSettings}
        selectedPaperCount={3}
        onRequestFileData={async () => undefined}
        hasLocalPdf={false}
        annotations={[]}
        fileStorageSettings={{ nameTemplate: "{title}" }}
        onUpdatePaper={vi.fn()}
        arxivDownloadBusy={false}
        onDownloadArxiv={async () => ""}
        onDeleteAnnotation={vi.fn()}
      />
    );

    expect(markup).toContain("3 documents selected");
    expect(markup).toContain("Select a single document to view and edit its details.");
    expect(markup).not.toContain(">Title<");
  });
});
