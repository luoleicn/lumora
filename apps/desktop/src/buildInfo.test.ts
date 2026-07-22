import { describe, expect, it } from "vitest";
import { formatBuildTime } from "./buildInfo";

describe("formatBuildTime", () => {
  it("formats the injected ISO timestamp in the user's timezone", () => {
    expect(formatBuildTime("2026-07-22T13:04:05.678Z", -480)).toBe("2026-07-22 21:04:05 UTC+8");
    expect(formatBuildTime("2026-07-22T13:04:05.678Z", 240)).toBe("2026-07-22 09:04:05 UTC-4");
  });

  it("handles date rollover and fractional-hour offsets", () => {
    expect(formatBuildTime("2026-07-22T20:04:05.678Z", -345)).toBe("2026-07-23 01:49:05 UTC+5:45");
  });

  it("uses an unadorned UTC label for zero offset", () => {
    expect(formatBuildTime("2026-07-22T13:04:05.678Z", 0)).toBe("2026-07-22 13:04:05 UTC");
  });

  it("preserves an unexpected build-time value", () => {
    expect(formatBuildTime("unknown")).toBe("unknown");
  });
});
