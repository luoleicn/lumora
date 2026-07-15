import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseTag } from "./release-version.mjs";

const ARTIFACTS = {
  "darwin-aarch64": "lumora-{tag}-macos-arm64.app.tar.gz",
  "darwin-x86_64": "lumora-{tag}-macos-x64.app.tar.gz",
  "linux-x86_64-appimage": "lumora-{tag}-linux-amd64.AppImage",
  "linux-x86_64-deb": "lumora-{tag}-linux-amd64.deb",
  "windows-x86_64-nsis": "lumora-{tag}-windows-x64-setup.exe",
  "windows-x86_64-msi": "lumora-{tag}-windows-x64.msi",
};

export function generateUpdaterManifest({ tag, repository, artifactsDir, notes = "", pubDate }) {
  const version = parseReleaseTag(tag);
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository '${repository}'. Expected owner/repository.`);
  }

  const platforms = Object.fromEntries(Object.entries(ARTIFACTS).map(([platform, pattern]) => {
    const filename = pattern.replace("{tag}", tag);
    const artifactPath = resolve(artifactsDir, filename);
    const signaturePath = `${artifactPath}.sig`;
    // Reading both files is deliberate validation: publishing must fail before
    // latest.json can point at an incomplete or unsigned updater asset.
    readFileSync(artifactPath);
    const signature = readFileSync(signaturePath, "utf8").trim();
    if (!signature) throw new Error(`Updater signature is empty: ${signaturePath}`);
    const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
    return [platform, { signature, url }];
  }));

  return {
    version,
    notes,
    pub_date: pubDate ?? new Date().toISOString(),
    platforms,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be provided as --name value pairs.");
    }
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const required of ["tag", "repository", "artifacts", "output"]) {
      if (!args[required]) throw new Error(`Missing required argument --${required}.`);
    }
    const manifest = generateUpdaterManifest({
      tag: args.tag,
      repository: args.repository,
      artifactsDir: args.artifacts,
      notes: args["notes-file"] ? readFileSync(args["notes-file"], "utf8") : "",
      pubDate: args["pub-date"],
    });
    writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`Generated updater manifest at ${resolve(args.output)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
