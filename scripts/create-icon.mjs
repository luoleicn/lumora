import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const source = resolve("apps/desktop/src-tauri/icons/lumora-logo-source.png");
const frontendLogo = resolve("apps/desktop/src/assets/lumora-logo.png");
const frontendLogo128 = resolve("apps/desktop/src/assets/lumora-logo-128.png");
const frontendLogo64 = resolve("apps/desktop/src/assets/lumora-logo-64.png");
const publicLogo64 = resolve("apps/desktop/public/lumora-logo-64.png");
const tauriIcon = resolve("apps/desktop/src-tauri/icons/icon.png");

async function resize(size, output) {
  await mkdir(dirname(output), { recursive: true });
  await execFileAsync("sips", ["-z", String(size), String(size), source, "--out", output]);
}

await mkdir(dirname(frontendLogo), { recursive: true });
await mkdir(dirname(publicLogo64), { recursive: true });
await copyFile(source, frontendLogo);
await resize(128, frontendLogo128);
await resize(64, frontendLogo64);
await resize(64, publicLogo64);
await resize(512, tauriIcon);

console.log("Updated lumora logo assets.");
