import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CONFIG_PATH = resolve(
  SCRIPT_DIR,
  "../apps/desktop/src-tauri/tauri.release.conf.json",
);

export function parseReleaseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  const prereleaseIdentifiers = match?.[4]?.split(".") ?? [];
  const hasInvalidNumericIdentifier = prereleaseIdentifiers.some(
    (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
  );

  if (!match || hasInvalidNumericIdentifier) {
    throw new Error(
      `Invalid release tag '${tag}'. Expected vX.Y.Z or vX.Y.Z-prerelease.`,
    );
  }

  return tag.slice(1);
}

export function writeTauriReleaseConfig(tag, outputPath = DEFAULT_CONFIG_PATH) {
  const version = parseReleaseTag(tag);
  const resolvedOutputPath = resolve(outputPath);

  mkdirSync(dirname(resolvedOutputPath), { recursive: true });
  writeFileSync(
    resolvedOutputPath,
    `${JSON.stringify({ version }, null, 2)}\n`,
    "utf8",
  );

  return { version, outputPath: resolvedOutputPath };
}

function isMainModule() {
  return process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const [, , tag, outputPath] = process.argv;
  if (!tag) {
    console.error("Usage: node scripts/release-version.mjs <vX.Y.Z> [output-path]");
    process.exitCode = 1;
  } else {
    try {
      const result = writeTauriReleaseConfig(tag, outputPath);
      console.log(
        `Prepared Tauri release version ${result.version} at ${result.outputPath}`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
