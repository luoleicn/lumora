import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseReleaseTag, writeTauriReleaseConfig } from "./release-version.mjs";

test("extracts stable and prerelease versions from release tags", () => {
  assert.equal(parseReleaseTag("v1.2.3"), "1.2.3");
  assert.equal(parseReleaseTag("v2.0.0-beta.1"), "2.0.0-beta.1");
});

test("rejects tags that are not canonical release versions", () => {
  for (const tag of [
    "1.2.3",
    "v1.2",
    "release-v1.2.3",
    "v01.2.3",
    "v1.2.3-01",
    "v1.2.3+build",
  ]) {
    assert.throws(() => parseReleaseTag(tag), /Invalid release tag/);
  }
});

test("writes a signed-updater release overlay with macOS ad-hoc signing", () => {
  const directory = mkdtempSync(join(tmpdir(), "lumora-release-version-"));
  const outputPath = join(directory, "tauri.release.conf.json");

  try {
    const result = writeTauriReleaseConfig("v3.4.5", outputPath);
    assert.equal(result.version, "3.4.5");
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), {
      version: "3.4.5",
      bundle: {
        createUpdaterArtifacts: true,
        macOS: { signingIdentity: "-" },
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
