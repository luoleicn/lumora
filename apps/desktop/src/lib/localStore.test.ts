import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listFileBlobIds } from "./localStore";

type Callback = (() => void) | null;

describe("attachment key enumeration", () => {
  let keys: { result: IDBValidKey[]; error: Error | null; onsuccess: Callback; onerror: Callback };
  let transaction: { error: Error | null; oncomplete: Callback; onerror: Callback; onabort: Callback; objectStore: ReturnType<typeof vi.fn> };
  let db: { close: ReturnType<typeof vi.fn>; transaction: ReturnType<typeof vi.fn> };
  let open: { result: typeof db; error: Error | null; onsuccess: Callback; onerror: Callback };
  let getAllKeys: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    keys = { result: [], error: null, onsuccess: null, onerror: null };
    getAllKeys = vi.fn(() => keys);
    transaction = { error: null, oncomplete: null, onerror: null, onabort: null, objectStore: vi.fn(() => ({ getAllKeys })) };
    db = { close: vi.fn(), transaction: vi.fn(() => transaction) };
    open = { result: db, error: null, onsuccess: null, onerror: null };
    vi.stubGlobal("indexedDB", { open: vi.fn(() => open) });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function openStore() {
    const result = listFileBlobIds();
    open.onsuccess!();
    await vi.waitFor(() => expect(getAllKeys).toHaveBeenCalledOnce());
    return { result };
  }

  it("reads keys in one readonly transaction and waits for commit before closing", async () => {
    const { result } = await openStore();
    keys.result = ["file-a", "file-b", 123]; keys.onsuccess!();
    expect(db.close).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledExactlyOnceWith("files", "readonly");
    expect(getAllKeys).toHaveBeenCalledOnce();
    transaction.oncomplete!();
    await expect(result).resolves.toEqual(new Set(["file-a", "file-b"]));
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("returns an empty set without loading Blob values", async () => {
    const { result } = await openStore();
    keys.onsuccess!(); transaction.oncomplete!();
    await expect(result).resolves.toEqual(new Set());
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("rejects request errors and closes the connection", async () => {
    const { result } = await openStore();
    keys.error = new Error("Read failed"); keys.onerror!();
    await expect(result).rejects.toThrow("Read failed");
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("rejects an aborted transaction even after its request returned keys", async () => {
    const { result } = await openStore();
    keys.result = ["file-a"]; keys.onsuccess!(); transaction.onabort!();
    await expect(result).rejects.toThrow("aborted");
    expect(db.close).toHaveBeenCalledOnce();
  });
});
