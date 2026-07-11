import { invoke } from "@tauri-apps/api/core";

export type ProxySettings = {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
};

export const defaultProxySettings: ProxySettings = {
  enabled: false,
  url: "",
  username: "",
  password: ""
};

export async function loadProxySettings(): Promise<ProxySettings> {
  return invoke<ProxySettings>("proxy_settings");
}

export async function saveProxySettings(settings: ProxySettings): Promise<void> {
  await invoke("set_proxy_settings", { settings });
}
