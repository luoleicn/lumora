import { check, type CheckOptions, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { ProxySettings } from "./proxySettings";

export type UpdateCheckSource = "startup" | "manual";

export type AppUpdateState = {
  visible: boolean;
  phase: "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "readyToRestart" | "error";
  currentVersion?: string;
  version?: string;
  date?: string;
  notes?: string;
  downloadedBytes: number;
  totalBytes?: number;
  error?: string;
  retry: "check" | "install" | null;
};

type UpdaterDependencies = {
  check: (options?: CheckOptions) => Promise<Update | null>;
  relaunch: () => Promise<void>;
};

export const initialAppUpdateState: AppUpdateState = {
  visible: false,
  phase: "idle",
  downloadedBytes: 0,
  retry: null
};

export function buildUpdaterProxy(settings: ProxySettings): string | undefined {
  if (!settings.enabled || !settings.url.trim()) {
    return undefined;
  }

  const proxy = new URL(settings.url.trim());
  if (settings.username) {
    proxy.username = settings.username;
    proxy.password = settings.password;
  }
  return proxy.toString();
}

export class AppUpdater {
  private state = initialAppUpdateState;
  private listener?: (state: AppUpdateState) => void;
  private update?: Update;
  private checkInFlight?: Promise<void>;
  private startupChecked = false;

  constructor(private readonly dependencies: UpdaterDependencies = { check, relaunch }) {}

  subscribe(listener: (state: AppUpdateState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) {
        this.listener = undefined;
      }
    };
  }

  getState(): AppUpdateState {
    return this.state;
  }

  async checkForUpdates(source: UpdateCheckSource, proxySettings: ProxySettings): Promise<void> {
    if (this.state.phase === "readyToRestart") {
      this.setState({ ...this.state, visible: true });
      return;
    }
    if (source === "startup" && this.startupChecked) {
      return;
    }
    if (source === "startup") {
      this.startupChecked = true;
    }
    if (this.checkInFlight) {
      if (source === "manual") {
        this.setState({ ...this.state, visible: true });
      }
      return this.checkInFlight;
    }

    const task = this.performCheck(source, proxySettings);
    this.checkInFlight = task;
    try {
      await task;
    } finally {
      this.checkInFlight = undefined;
    }
  }

  async downloadAndInstall(): Promise<void> {
    const update = this.update;
    if (!update || this.state.phase === "downloading" || this.state.phase === "installing") {
      return;
    }

    this.setState({
      ...this.state,
      visible: true,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: undefined,
      error: undefined,
      retry: null
    });

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          this.setState({ ...this.state, totalBytes: event.data.contentLength, downloadedBytes: 0 });
        } else if (event.event === "Progress") {
          this.setState({ ...this.state, downloadedBytes: this.state.downloadedBytes + event.data.chunkLength });
        } else {
          this.setState({ ...this.state, phase: "installing" });
        }
      });
      await this.releaseUpdate();
      this.setState({ ...this.state, phase: "readyToRestart", downloadedBytes: this.state.totalBytes ?? this.state.downloadedBytes });
    } catch (error) {
      this.setState({
        ...this.state,
        phase: "error",
        error: errorMessage(error),
        retry: "install"
      });
    }
  }

  async retry(proxySettings: ProxySettings): Promise<void> {
    if (this.state.retry === "install" && this.update) {
      await this.downloadAndInstall();
      return;
    }
    await this.checkForUpdates("manual", proxySettings);
  }

  async restart(): Promise<void> {
    await this.dependencies.relaunch();
  }

  async dismiss(): Promise<void> {
    if (this.state.phase === "downloading" || this.state.phase === "installing") {
      return;
    }
    if (this.state.phase !== "readyToRestart") {
      await this.releaseUpdate();
      this.setState(initialAppUpdateState);
      return;
    }
    this.setState({ ...this.state, visible: false });
  }

  async dispose(): Promise<void> {
    this.listener = undefined;
    await this.releaseUpdate();
  }

  private async performCheck(source: UpdateCheckSource, proxySettings: ProxySettings): Promise<void> {
    await this.releaseUpdate();
    this.setState({
      ...initialAppUpdateState,
      visible: source === "manual",
      phase: "checking"
    });

    try {
      const proxy = buildUpdaterProxy(proxySettings);
      const update = await this.dependencies.check({
        timeout: 15_000,
        allowDowngrades: false,
        ...(proxy ? { proxy } : {})
      });

      if (!update) {
        this.setState(source === "manual"
          ? { ...initialAppUpdateState, visible: true, phase: "upToDate" }
          : initialAppUpdateState);
        return;
      }

      this.update = update;
      this.setState({
        visible: true,
        phase: "available",
        currentVersion: update.currentVersion,
        version: update.version,
        date: update.date,
        notes: update.body,
        downloadedBytes: 0,
        retry: null
      });
    } catch (error) {
      this.setState(source === "manual"
        ? {
            ...initialAppUpdateState,
            visible: true,
            phase: "error",
            error: errorMessage(error),
            retry: "check"
          }
        : initialAppUpdateState);
    }
  }

  private async releaseUpdate(): Promise<void> {
    const update = this.update;
    this.update = undefined;
    if (update) {
      await update.close().catch(() => undefined);
    }
  }

  private setState(state: AppUpdateState): void {
    this.state = state;
    this.listener?.(state);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
