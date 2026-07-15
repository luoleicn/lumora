import type { Update } from "@tauri-apps/plugin-updater";
import { describe, expect, it, vi } from "vitest";
import { AppUpdater, buildUpdaterProxy } from "./appUpdater";
import { defaultProxySettings, type ProxySettings } from "./proxySettings";

function fakeUpdate(overrides: Partial<Update> = {}): Update {
  return {
    currentVersion: "1.0.0",
    version: "1.1.0",
    date: "2026-07-15T00:00:00Z",
    body: "Faster reading",
    rawJson: {},
    rid: 1,
    download: vi.fn(),
    install: vi.fn(),
    downloadAndInstall: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Update;
}

describe("buildUpdaterProxy", () => {
  it("adds encoded credentials only when the proxy is enabled", () => {
    const settings: ProxySettings = {
      enabled: true,
      url: "http://127.0.0.1:8080",
      username: "reader@example.com",
      password: "a/b",
    };
    expect(buildUpdaterProxy(settings)).toBe("http://reader%40example.com:a%2Fb@127.0.0.1:8080/");
    expect(buildUpdaterProxy({ ...settings, enabled: false })).toBeUndefined();
  });
});

describe("AppUpdater", () => {
  it("keeps startup checks silent when no update exists and only runs once", async () => {
    const check = vi.fn().mockResolvedValue(null);
    const updater = new AppUpdater({ check, relaunch: vi.fn() });
    await updater.checkForUpdates("startup", defaultProxySettings);
    await updater.checkForUpdates("startup", defaultProxySettings);
    expect(check).toHaveBeenCalledTimes(1);
    expect(updater.getState()).toMatchObject({ visible: false, phase: "idle" });
  });

  it("shows manual up-to-date and error results", async () => {
    const check = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline"));
    const updater = new AppUpdater({ check, relaunch: vi.fn() });
    await updater.checkForUpdates("manual", defaultProxySettings);
    expect(updater.getState()).toMatchObject({ visible: true, phase: "upToDate" });
    await updater.checkForUpdates("manual", defaultProxySettings);
    expect(updater.getState()).toMatchObject({ visible: true, phase: "error", retry: "check", error: "offline" });
  });

  it("reports progress, installs, and offers a restart", async () => {
    const update = fakeUpdate({
      downloadAndInstall: vi.fn(async (listener) => {
        listener?.({ event: "Started", data: { contentLength: 10 } });
        listener?.({ event: "Progress", data: { chunkLength: 10 } });
        listener?.({ event: "Finished" });
      }),
    });
    const relaunch = vi.fn().mockResolvedValue(undefined);
    const updater = new AppUpdater({ check: vi.fn().mockResolvedValue(update), relaunch });
    await updater.checkForUpdates("manual", defaultProxySettings);
    expect(updater.getState()).toMatchObject({ phase: "available", version: "1.1.0" });
    await updater.downloadAndInstall();
    expect(updater.getState()).toMatchObject({ phase: "readyToRestart", downloadedBytes: 10 });
    expect(update.close).toHaveBeenCalledOnce();
    await updater.restart();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("retains the update handle so a failed install can be retried", async () => {
    const downloadAndInstall = vi.fn()
      .mockRejectedValueOnce(new Error("download interrupted"))
      .mockResolvedValueOnce(undefined);
    const update = fakeUpdate({ downloadAndInstall });
    const updater = new AppUpdater({ check: vi.fn().mockResolvedValue(update), relaunch: vi.fn() });
    await updater.checkForUpdates("manual", defaultProxySettings);
    await updater.downloadAndInstall();
    expect(updater.getState()).toMatchObject({ phase: "error", retry: "install" });
    await updater.retry(defaultProxySettings);
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(updater.getState().phase).toBe("readyToRestart");
  });
});
