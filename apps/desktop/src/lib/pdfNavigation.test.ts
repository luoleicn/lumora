import { describe, expect, it } from "vitest";
import {
  PdfScrollCoordinator,
  planPdfScroll
} from "./pdfNavigation";

const metrics = {
  offsets: [0, 820, 1640, 2460],
  heights: [800, 800, 800, 800],
  totalHeight: 3260
};

describe("PDF virtual navigation", () => {
  it("materializes the destination window before committing its scroll", () => {
    const plan = planPdfScroll(metrics, 2020, 700, 0, "smooth");

    expect(plan.top).toBe(2020);
    expect(plan.range.start).toBeLessThanOrEqual(2);
    expect(plan.range.end).toBeGreaterThanOrEqual(2);
  });

  it("clamps scroll plans to the virtual document bounds", () => {
    expect(planPdfScroll(metrics, -200, 700, 0, "auto").top).toBe(0);
    expect(planPdfScroll(metrics, 10_000, 700, 0, "auto").top).toBe(2560);
    expect(planPdfScroll(metrics, Number.NaN, 700, 0, "auto").top).toBe(0);
  });

  it("prevents a stale page-one restore from overriding link navigation", () => {
    const coordinator = new PdfScrollCoordinator();
    coordinator.resetForDocument();
    const restore = coordinator.beginRestore(
      planPdfScroll(metrics, 0, 700, 1, "auto")
    );
    const navigation = coordinator.beginNavigation(
      planPdfScroll(metrics, 2020, 700, 1, "smooth")
    );

    expect(coordinator.isRestoring).toBe(false);
    expect(coordinator.complete(restore)).toBe(false);
    expect(coordinator.isCurrent(navigation.revision)).toBe(true);
    expect(coordinator.complete(navigation)).toBe(true);
  });
});
