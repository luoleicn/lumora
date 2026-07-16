import { describe, expect, it } from "vitest";
import { resolveVirtualListRange } from "./listVirtualization";

describe("list virtualization", () => {
  const metrics = { itemHeight: 34, leadingHeight: 29, overscanItems: 12 };

  it("renders a bounded initial window while preserving the full list height", () => {
    expect(resolveVirtualListRange(594, 0, 700, metrics)).toEqual({
      start: 0,
      end: 32,
      paddingBefore: 0,
      paddingAfter: 19_108
    });
  });

  it("moves the render window with scroll position", () => {
    expect(resolveVirtualListRange(594, 3_429, 700, metrics)).toEqual({
      start: 88,
      end: 133,
      paddingBefore: 2_992,
      paddingAfter: 15_674
    });
  });

  it("clamps invalid measurements and the final window", () => {
    expect(resolveVirtualListRange(5, Number.NaN, Number.NaN, metrics)).toEqual({
      start: 0,
      end: 5,
      paddingBefore: 0,
      paddingAfter: 0
    });
    expect(resolveVirtualListRange(5, 10_000, 700, metrics)).toEqual({
      start: 5,
      end: 5,
      paddingBefore: 170,
      paddingAfter: 0
    });
  });
});
