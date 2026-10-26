import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEVELOPMENT_LIBRARIES = [
  ["gtk+-3.0", "libgtk-3-dev"],
  ["webkit2gtk-4.1", "libwebkit2gtk-4.1-dev"],
  ["librsvg-2.0", "librsvg2-dev"],
  ["dbus-1", "libdbus-1-dev"],
  ["openssl", "libssl-dev"],
];

export function checkLinuxBuildDependencies(run = spawnSync) {
  const missing = [];
  const hasPkgConfig = run("pkg-config", ["--version"], { stdio: "ignore" }).status === 0;

  if (!hasPkgConfig) {
    missing.push("pkg-config");
  } else {
    for (const [library, packageName] of DEVELOPMENT_LIBRARIES) {
      if (run("pkg-config", ["--exists", library], { stdio: "ignore" }).status !== 0) {
        missing.push(packageName);
      }
    }
  }

  for (const command of ["patchelf", "file"]) {
    if (run(command, ["--version"], { stdio: "ignore" }).status !== 0) {
      missing.push(command);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing Linux build dependencies: ${missing.join(", ")}.\n`
      + "Runtime libraries alone are insufficient; development packages are required, even with cached Cargo artifacts.\n"
      + "On Ubuntu / Debian, install the prerequisites and retry:\n"
      + "  sudo apt-get update\n"
      + "  sudo apt-get install -y pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libsecret-1-dev librsvg2-dev libdbus-1-dev build-essential libssl-dev patchelf file curl wget libxdo-dev libayatana-appindicator3-dev poppler-utils\n"
      + "For other distributions, see https://v2.tauri.app/start/prerequisites/#linux",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "linux") {
      throw new Error("tauri:build:linux requires a native Linux build environment.");
    }
    checkLinuxBuildDependencies();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
