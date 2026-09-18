/**
 * Usage ledger size-limit enforcement.
 *
 * When `usageLedgerMaxBytes` is configured, this module truncates `usage.jsonl`
 * after a write causes the file to exceed the limit. Truncation keeps only
 * the newest complete JSONL rows that fit within the budget, written to a
 * temporary file and atomically renamed over the original. The derived
 * `routing-history.sqlite` index is deleted so it auto-rebuilds on next query.
 *
 * Design constraints (from PR #4042 lessons & CodeRabbit review):
 *  - Memory usage stays bounded: uses backward chunk scanning (max 64 KiB chunks)
 *    to find row boundaries, streaming/copying in chunks rather than allocating
 *    the entire maxBytes buffer in memory.
 *  - Only complete JSONL rows are retained; partial/torn tails are discarded.
 *  - A valid single oversized row (larger than the limit) is preserved.
 *    An invalid/unterminated oversized crash tail is discarded.
 *  - Atomic replace via rename prevents data loss on crash.
 *  - Invalidation: discards in-memory usage snapshot and deletes derived sqlite index.
 *  - Best-effort: failures are logged/swallowed so request paths never fail.
 *  - No scheduler or background worker: inline enforcement after append.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import { discardRetainedUsageSnapshot, normalizePersistedUsageRow } from "./log";

/** Floor: retention limits below this are treated as unconfigured. */
export const MIN_USAGE_LEDGER_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Default ceiling when enabled through the GUI (1 GiB). */
export const DEFAULT_USAGE_LEDGER_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Bounded chunk size for backward scanning and copying (64 KiB). */
const SCAN_CHUNK_BYTES = 64 * 1024;

let truncationInProgress = false;

/**
 * Module-level configured limit. Set once from config at startup via
 * `setUsageLedgerMaxBytes()`. The default (`undefined`) means no limit.
 */
let configuredMaxBytes: number | undefined;

/**
 * Set the configured max bytes for usage ledger retention.
 * Called from the startup path after config is loaded.
 */
export function setUsageLedgerMaxBytes(maxBytes: number | undefined): void {
  configuredMaxBytes = (maxBytes !== undefined && maxBytes >= MIN_USAGE_LEDGER_MAX_BYTES)
    ? maxBytes
    : undefined;
}

/** Read the currently configured limit (test observability). */
export function getUsageLedgerMaxBytes(): number | undefined {
  return configuredMaxBytes;
}

/**
 * If a limit is configured and the file at `ledgerPath` exceeds it,
 * rewrite the file keeping only the newest complete rows that fit.
 *
 * Called synchronously after `appendUsageEntry`; must never throw into
 * the request path.
 */
export function enforceUsageLedgerSizeLimit(ledgerPath: string): void {
  if (configuredMaxBytes === undefined) return;
  if (truncationInProgress) return;

  let fd: number | undefined;
  try {
    fd = openSync(ledgerPath, "r");
    const size = Number(fstatSync(fd).size);
    if (size <= configuredMaxBytes) return;
    closeSync(fd);
    fd = undefined;

    truncationInProgress = true;
    try {
      truncateUsageLedger(ledgerPath, configuredMaxBytes);
    } finally {
      truncationInProgress = false;
    }
  } catch {
    // Best-effort: a failure here must not block the request that just
    // appended its usage row successfully.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Check if a line is a valid, parseable usage entry. */
function isValidUsageRow(line: string): boolean {
  try {
    return normalizePersistedUsageRow(JSON.parse(line)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Read the ledger with bounded memory to find the newest complete JSONL rows
 * fitting within `maxBytes`, write them to a temp file, and atomically replace.
 */
function truncateUsageLedger(ledgerPath: string, maxBytes: number): void {
  let inFd: number | undefined;
  let outFd: number | undefined;
  const tmpPath = join(dirname(ledgerPath), `.usage-retention-${process.pid}.tmp`);

  try {
    inFd = openSync(ledgerPath, "r");
    const fileSize = Number(fstatSync(inFd).size);
    if (fileSize <= maxBytes) return;

    // Phase 1: Determine the valid retained range [retainedStart, retainedEnd)
    // First, check the end of the file. If it doesn't end with LF, find the last LF.
    let retainedEnd = fileSize;
    const tailCheckSize = Math.min(fileSize, SCAN_CHUNK_BYTES);
    const tailBuffer = Buffer.allocUnsafe(tailCheckSize);
    const tailRead = readSync(inFd, tailBuffer, 0, tailCheckSize, fileSize - tailCheckSize);

    if (tailRead > 0 && tailBuffer[tailRead - 1] !== 0x0a) {
      // Missing trailing newline: crash tail or unterminated line.
      // Search backward for the last LF in the file.
      let foundLastLf = -1;
      let checkOffset = fileSize;

      while (checkOffset > 0 && foundLastLf === -1) {
        const chunkSize = Math.min(checkOffset, SCAN_CHUNK_BYTES);
        const buf = Buffer.allocUnsafe(chunkSize);
        const bytesRead = readSync(inFd, buf, 0, chunkSize, checkOffset - chunkSize);
        if (bytesRead === 0) break;
        const lastIdx = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (lastIdx >= 0) {
          foundLastLf = (checkOffset - chunkSize) + lastIdx + 1;
        } else {
          checkOffset -= chunkSize;
        }
      }

      if (foundLastLf === -1) {
        // No newline anywhere in the entire file.
        // If it's valid usage JSON (e.g. single line without trailing LF), keep it.
        // Otherwise it's corrupt crash data — discard by writing empty file.
        const entireLine = fileSize <= 10 * 1024 * 1024 // Only parse if reasonable size
          ? (() => {
              const b = Buffer.allocUnsafe(fileSize);
              readSync(inFd, b, 0, fileSize, 0);
              return b.toString("utf-8");
            })()
          : null;

        if (entireLine && isValidUsageRow(entireLine)) {
          return; // Valid oversized row, preserve original
        }
        // Invalid or corrupt single line: write empty file
        retainedEnd = 0;
      } else {
        retainedEnd = foundLastLf;
      }
    }

    // Now determine retainedStart so that (retainedEnd - retainedStart) <= maxBytes
    // and retainedStart sits right after an LF (complete row boundary).
    let retainedStart = 0;
    const targetLength = retainedEnd;

    if (targetLength > maxBytes) {
      const minStart = retainedEnd - maxBytes;
      // We need to scan forward from minStart to find the first LF,
      // so the retained region starts at that LF + 1.
      let scanOffset = minStart;
      let foundFirstLf = -1;

      while (scanOffset < retainedEnd && foundFirstLf === -1) {
        const chunkSize = Math.min(retainedEnd - scanOffset, SCAN_CHUNK_BYTES);
        const buf = Buffer.allocUnsafe(chunkSize);
        const bytesRead = readSync(inFd, buf, 0, chunkSize, scanOffset);
        if (bytesRead === 0) break;
        const firstIdx = buf.subarray(0, bytesRead).indexOf(0x0a);
        if (firstIdx >= 0) {
          foundFirstLf = scanOffset + firstIdx + 1;
        } else {
          scanOffset += chunkSize;
        }
      }

      if (foundFirstLf === -1 || foundFirstLf >= retainedEnd) {
        // The entire retained region is part of one giant line that spans > maxBytes.
        // Check if the entire file is a single oversized valid row.
        if (retainedEnd === fileSize) {
          return; // Single oversized valid row, preserve as-is
        }
        // Otherwise no complete rows could be kept
        retainedStart = retainedEnd;
      } else {
        retainedStart = foundFirstLf;
      }
    }

    const retainedBytes = retainedEnd - retainedStart;

    // Phase 2: Copy [retainedStart, retainedEnd) to tmpPath in bounded chunks
    outFd = openSync(tmpPath, "w", 0o600);
    try { chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }

    if (retainedBytes > 0) {
      let copyOffset = retainedStart;
      const copyBuffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);

      while (copyOffset < retainedEnd) {
        const toRead = Math.min(retainedEnd - copyOffset, SCAN_CHUNK_BYTES);
        const bytesRead = readSync(inFd, copyBuffer, 0, toRead, copyOffset);
        if (bytesRead === 0) break;
        writeSync(outFd, copyBuffer, 0, bytesRead);
        copyOffset += bytesRead;
      }
    }

    closeSync(outFd);
    outFd = undefined;
    closeSync(inFd);
    inFd = undefined;

    renameAtomicFile(tmpPath, ledgerPath, undefined, "usage-ledger-retention");
    discardRetainedUsageSnapshot();
    deleteRoutingHistoryIndex(ledgerPath);
  } catch {
    // Failure is tolerated; clean up temp file if present
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  } finally {
    if (inFd !== undefined) {
      try { closeSync(inFd); } catch { /* ignore */ }
    }
    if (outFd !== undefined) {
      try { closeSync(outFd); } catch { /* ignore */ }
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Best-effort deletion of the derived routing-history SQLite index.
 * The indexer auto-rebuilds from `usage.jsonl` on next query.
 */
function deleteRoutingHistoryIndex(ledgerPath: string): void {
  const dir = dirname(ledgerPath);
  for (const suffix of ["routing-history.sqlite", "routing-history.sqlite-wal", "routing-history.sqlite-shm"]) {
    const path = join(dir, suffix);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch { /* best-effort */ }
  }
}

/** Test-only: expose truncation state for assertions. */
export function isTruncationInProgressForTests(): boolean {
  return truncationInProgress;
}

/**
 * Test-only: bypass the MIN_USAGE_LEDGER_MAX_BYTES floor.
 * Production code must use `setUsageLedgerMaxBytes()`.
 */
export function setUsageLedgerMaxBytesUnsafe(maxBytes: number | undefined): void {
  configuredMaxBytes = maxBytes;
}
