import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { loadProxySettings, saveProxySettings, type ProxySettings } from "./proxySettings";

const socksSettings: ProxySettings = {
  enabled: true,
  url: "socks5h://127.0.0.1:1080",
  username: "reader",
  password: "secret"
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("proxy settings client", () => {
  it("loads settings from the desktop network layer", async () => {
    invokeMock.mockResolvedValue(socksSettings);
    await expect(loadProxySettings()).resolves.toEqual(socksSettings);
    expect(invokeMock).toHaveBeenCalledWith("proxy_settings");
  });

  it("saves SOCKS settings through the desktop network layer", async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveProxySettings(socksSettings);
    expect(invokeMock).toHaveBeenCalledWith("set_proxy_settings", { settings: socksSettings });
  });
});
