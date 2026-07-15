export type PromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type CompatiblePromiseConstructor = {
  withResolvers?: <T>() => PromiseResolvers<T>;
};

/**
 * PDF.js 5 uses Promise.withResolvers(), which is unavailable in the WebKit
 * shipped with macOS Ventura even though the same application works on newer
 * macOS releases. Install the standards-compatible capability before PDF.js
 * creates its first loading task.
 */
export function installWebKitPolyfills(
  target: CompatiblePromiseConstructor = Promise as unknown as CompatiblePromiseConstructor
) {
  if (typeof target.withResolvers !== "function") {
    Object.defineProperty(target, "withResolvers", {
      configurable: true,
      writable: true,
      value: createPromiseResolvers
    });
  }
}

export function createPromiseResolvers<T>(): PromiseResolvers<T> {
  let resolve!: PromiseResolvers<T>["resolve"];
  let reject!: PromiseResolvers<T>["reject"];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

installWebKitPolyfills();
