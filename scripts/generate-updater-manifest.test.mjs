import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateUpdaterManifest } from "./generate-updater-manifest.mjs";

const filenames = [
  "lumora-v1.2.3-macos-arm64.app.tar.gz",
  "lumora-v1.2.3-macos-x64.app.tar.gz",
  "lumora-v1.2.3-linux-amd64.AppImage",
  "lumora-v1.2.3-linux-amd64.deb",
  "lumora-v1.2.3-windows-x64-setup.exe",
  "lumora-v1.2.3-windows-x64.msi",
];

test("builds an installer-aware static updater manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "lumora-updater-manifest-"));
  try {
    filenames.forEach((filename, index) => {
      writeFileSync(join(directory, filename), `artifact-${index}`);
      writeFileSync(join(directory, `${filename}.sig`), `signature-${index}\n`);
    });
    const manifest = generateUpdaterManifest({
      tag: "v1.2.3",
      repository: "luoleicn/lumora",
      artifactsDir: directory,
      notes: "Release notes",
      pubDate: "2026-07-15T00:00:00.000Z",
    });

    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.notes, "Release notes");
    assert.deepEqual(Object.keys(manifest.platforms), [
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "windows-x86_64-nsis",
      "windows-x86_64-msi",
    ]);
    assert.equal(manifest.platforms["windows-x86_64-nsis"].signature, "signature-4");
    assert.match(manifest.platforms["darwin-aarch64"].url, /lumora-v1.2.3-macos-arm64\.app\.tar\.gz$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to publish a manifest when a signature is missing", () => {
  const directory = mkdtempSync(join(tmpdir(), "lumora-updater-manifest-"));
  try {
    assert.throws(() => generateUpdaterManifest({
      tag: "v1.2.3",
      repository: "luoleicn/lumora",
      artifactsDir: directory,
    }), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
