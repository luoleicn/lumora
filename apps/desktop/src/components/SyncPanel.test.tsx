import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultSyncSettings } from "../lib/syncClient";
import { SyncPanel } from "./SyncPanel";

describe("SyncPanel", () => {
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
