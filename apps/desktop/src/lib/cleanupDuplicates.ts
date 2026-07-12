import { invoke } from "@tauri-apps/api/core";
import type { FileStorageSettings } from "./fileStorage";

export type DuplicateGroupFile = {
  fileName: string;
  size: number;
  kept: boolean;
  referencedBy: string[];
};

export type DuplicateGroup = {
  sha256: string;
  files: DuplicateGroupFile[];
  totalCopies?: number;
};

export type CleanupDuplicateSummary = {
  dir: string;
  totalFilesScanned: number;
  uniqueHashes: number;
  duplicateGroups: DuplicateGroup[];
  filesRemoved: number;
  bytesFreed: number;
  libraryRecordsUpdated: number;
  dryRun: boolean;
  errors: string[];
};

export function formatCleanupSummary(summary: CleanupDuplicateSummary): string {
  const lines: string[] = [];
  lines.push(`Scanned ${summary.totalFilesScanned} PDF files in ${summary.dir}`);
  lines.push(`${summary.uniqueHashes} unique content hashes.`);

  if (summary.duplicateGroups.length === 0) {
    lines.push("No duplicate files found.");
    return lines.join("\n");
  }

  lines.push(
    `Found ${summary.duplicateGroups.length} duplicate group(s) (${summary.duplicateGroups.reduce((sum, g) => sum + g.files.length - 1, 0)} excess files, ${formatBytes(summary.bytesFreed)} total).`
  );

  for (const group of summary.duplicateGroups) {
    const copies = group.totalCopies ?? group.files.length;
    lines.push(`\n  sha256: ${group.sha256.slice(0, 12)}… — ${copies} copies`);
    for (const file of group.files) {
      const marker = file.kept ? "✓ KEEP" : "✗ REMOVE";
      const refs =
        file.referencedBy.length > 0
          ? ` (referenced by: ${file.referencedBy.join(", ")})`
          : "";
      lines.push(`    ${marker}  ${file.fileName}  ${formatBytes(file.size)}${refs}`);
    }
  }

  if (summary.errors.length > 0) {
    lines.push(`\nErrors:\n${summary.errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  if (summary.dryRun) {
    lines.push("\n⚠ Dry run — no files were actually removed.");
  } else {
    lines.push(
      `\nRemoved ${summary.filesRemoved} file(s), freed ${formatBytes(summary.bytesFreed)}, updated ${summary.libraryRecordsUpdated} library record(s).`
    );
  }

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Runs a dry-run duplicate scan on the configured file-storage folder.
 * Returns a full breakdown of which files would be kept / removed.
 */
export async function scanDuplicateDownloads(
  settings: FileStorageSettings
): Promise<CleanupDuplicateSummary> {
  if (!settings.directory) {
    return {
      dir: "",
      totalFilesScanned: 0,
      uniqueHashes: 0,
      duplicateGroups: [],
      filesRemoved: 0,
      bytesFreed: 0,
      libraryRecordsUpdated: 0,
      dryRun: true,
      errors: ["No file storage folder configured."],
    };
  }

  return invoke<CleanupDuplicateSummary>("cleanup_duplicate_downloads", {
    dir: settings.directory,
    dryRun: true,
  });
}

/**
 * Performs an actual cleanup: removes duplicate PDF files from the
 * storage folder (keeping one copy per group) and updates library
 * records to point to the kept file.
 */
export async function cleanupDuplicateDownloads(
  settings: FileStorageSettings
): Promise<CleanupDuplicateSummary> {
  if (!settings.directory) {
    throw new Error("No file storage folder configured.");
  }

  return invoke<CleanupDuplicateSummary>("cleanup_duplicate_downloads", {
    dir: settings.directory,
    dryRun: false,
  });
}
