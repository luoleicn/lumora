import { invoke } from "@tauri-apps/api/core";
import type { PDFDataRangeTransport } from "pdfjs-dist";

export const localPdfRangeChunkSize = 256 * 1024;

export type LocalPdfRangeSource = {
  directory: string;
  fileName: string;
  size: number;
};

export type PdfDataRangeTransportConstructor = new (
  length: number,
  initialData: Uint8Array | null,
  progressiveDone?: boolean,
  contentDispositionFilename?: string
) => PDFDataRangeTransport;

/**
 * Bridges PDF.js range requests directly to the native file handle. Keeping
 * the complete PDF out of WKWebView avoids the retained source Uint8Array and
 * its worker-transfer copy while preserving PDF.js canvas/text quality.
 */
export function createLocalPdfRangeTransport(
  BaseTransport: PdfDataRangeTransportConstructor,
  source: LocalPdfRangeSource,
  onReadError: (error: Error) => void,
  readRange: typeof readStoredPdfRange = readStoredPdfRange
): PDFDataRangeTransport {
  return new class extends BaseTransport {
    private aborted = false;
    private errorReported = false;

    constructor() {
      super(source.size, null, false, source.fileName);
    }

    requestDataRange(begin: number, end: number) {
      void readRange(source.directory, source.fileName, begin, end)
        .then((bytes) => {
          if (!this.aborted) {
            this.onDataRange(begin, bytes);
          }
        })
        .catch((reason) => {
          if (this.aborted || this.errorReported) {
            return;
          }
          this.errorReported = true;
          onReadError(reason instanceof Error ? reason : new Error(String(reason)));
        });
    }

    abort() {
      this.aborted = true;
    }
  }();
}

export async function readStoredPdfRange(
  directory: string,
  fileName: string,
  begin: number,
  end: number
): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_stored_pdf_range", {
    dir: directory,
    fileName,
    begin,
    end
  });
  return new Uint8Array(buffer);
}
