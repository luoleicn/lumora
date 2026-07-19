import { describe, expect, it } from "vitest";
import { PdfLinkReturnController } from "./pdfLinkReturn";

describe("PdfLinkReturnController", () => {
  it("keeps only the most recent link origin and consumes it once", () => {
    const controller = new PdfLinkReturnController();

    controller.beginLink(120);
    controller.beginLink(640);

    expect(controller.consumeReturn()).toBe(640);
    expect(controller.consumeReturn()).toBeUndefined();
  });

  it("invalidates pending destinations when returning or resetting", () => {
    const controller = new PdfLinkReturnController();
    const firstRevision = controller.beginLink(120);

    expect(controller.isCurrent(firstRevision)).toBe(true);
    controller.consumeReturn();
    expect(controller.isCurrent(firstRevision)).toBe(false);

    const secondRevision = controller.beginLink(240);
    controller.reset();
    expect(controller.isCurrent(secondRevision)).toBe(false);
    expect(controller.consumeReturn()).toBeUndefined();
  });

  it("normalizes invalid origins to a safe scroll offset", () => {
    const controller = new PdfLinkReturnController();
    controller.beginLink(Number.NaN);
    expect(controller.consumeReturn()).toBe(0);

    controller.beginLink(-20);
    expect(controller.consumeReturn()).toBe(0);
  });
});
