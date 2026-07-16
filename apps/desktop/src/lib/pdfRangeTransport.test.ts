import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

import {
  createLocalPdfRangeTransport,
  readStoredPdfRange,
  type PdfDataRangeTransportConstructor
} from "./pdfRangeTransport";

class FakePdfDataRangeTransport {
  private rangeListeners: Array<(begin: number, bytes: Uint8Array | null) => void> = [];

  constructor(
    readonly length: number,
    readonly initialData: Uint8Array | null,
    readonly progressiveDone = false,
    readonly contentDispositionFilename = ""
  ) {}

  addRangeListener(listener: (begin: number, bytes: Uint8Array | null) => void) {
    this.rangeListeners.push(listener);
  }

  onDataRange(begin: number, bytes: Uint8Array | null) {
    for (const listener of this.rangeListeners) {
      listener(begin, bytes);
    }
  }
}

const FakeTransport = FakePdfDataRangeTransport as unknown as PdfDataRangeTransportConstructor;

describe("local PDF range transport", () => {
  it("reads only the byte range requested by PDF.js", async () => {
    const readRange = vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6]));
    const onError = vi.fn();
    const transport = createLocalPdfRangeTransport(FakeTransport, {
      directory: "/library",
      fileName: "paper.pdf",
      size: 100
    }, onError, readRange);
    const received = vi.fn();
    transport.addRangeListener(received);

    transport.requestDataRange(4, 7);

    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(4, new Uint8Array([4, 5, 6])));
    expect(readRange).toHaveBeenCalledWith("/library", "paper.pdf", 4, 7);
    expect(onError).not.toHaveBeenCalled();
  });

  it("suppresses late range responses after PDF.js aborts the document", async () => {
    let resolveRange!: (bytes: Uint8Array) => void;
    const readRange = vi.fn(() => new Promise<Uint8Array>((resolve) => {
      resolveRange = resolve;
    }));
    const transport = createLocalPdfRangeTransport(FakeTransport, {
      directory: "/library",
      fileName: "paper.pdf",
      size: 100
    }, vi.fn(), readRange);
    const received = vi.fn();
    transport.addRangeListener(received);

    transport.requestDataRange(0, 10);
    transport.abort();
    resolveRange(new Uint8Array([1]));
    await Promise.resolve();

    expect(received).not.toHaveBeenCalled();
  });

  it("uses the raw native response without serializing byte arrays", async () => {
    invokeMock.mockResolvedValue(new Uint8Array([7, 8]).buffer);

    await expect(readStoredPdfRange("/library", "paper.pdf", 10, 12))
      .resolves.toEqual(new Uint8Array([7, 8]));
    expect(invokeMock).toHaveBeenCalledWith("read_stored_pdf_range", {
      dir: "/library",
      fileName: "paper.pdf",
      begin: 10,
      end: 12
    });
  });
});
