import { describe, expect, it } from "vitest";
import { createPromiseResolvers, installWebKitPolyfills, type PromiseResolvers } from "./webkitPolyfills";

describe("WebKit compatibility polyfills", () => {
  it("installs Promise.withResolvers only when it is unavailable", async () => {
    const target: { withResolvers?: <T>() => PromiseResolvers<T> } = {};

    installWebKitPolyfills(target);

    const capability = target.withResolvers!<number>();
    capability.resolve(42);
    await expect(capability.promise).resolves.toBe(42);
  });

  it("does not replace a native implementation", () => {
    const native = createPromiseResolvers;
    const target = { withResolvers: native };

    installWebKitPolyfills(target);

    expect(target.withResolvers).toBe(native);
  });

  it("creates a rejectable promise capability", async () => {
    const capability = createPromiseResolvers<never>();
    capability.reject(new Error("failed"));

    await expect(capability.promise).rejects.toThrow("failed");
  });
});
