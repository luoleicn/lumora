import { describe, expect, it } from "vitest";
import { formatActionError } from "./actionError";

describe("formatActionError", () => {
  it("uses the message of Error instances", () => {
    expect(formatActionError(new Error("boom"))).toBe("boom");
  });

  it("passes strings through", () => {
    expect(formatActionError("plain failure")).toBe("plain failure");
  });

  it("serializes plain objects", () => {
    expect(formatActionError({ code: 42 })).toBe('{"code":42}');
  });

  it("falls back to string conversion for unserializable objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatActionError(cyclic)).toBe("[object Object]");
  });

  it("reports a generic failure for nullish values", () => {
    expect(formatActionError(undefined)).toBe("Action failed.");
    expect(formatActionError(null)).toBe("Action failed.");
  });
});
