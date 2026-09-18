/**
 * Usage ledger size-limit enforcement.
 *
 * When `usageLedgerMaxBytes` is configured, this module truncates `usage.jsonl`
 * after a write causes the file to exceed the limit. Truncation keeps only
 * the newest complete JSONL rows that fit within the budget, written to a
 * temporary file and atomically renamed over the original. The derived
 * `routing-history.sqlite` index is deleted so it auto-rebuilds on next query.
 *
 * Design constraints (from PR #4042 lessons):
 *  - Only complete JSONL rows are retained; partial/torn tails are discarded.
 *  - A single oversized row (larger than the limit) is kept as the sole row
 *    rather than producing an empty file.
 *  - Atomic replace via rename prevents data loss on crash.
 *  - The retained snapshot uses `discardRetainedUsageSnapshot()` to invalidate
 *    the in-memory cache so the next management read re-parses.
 *  - Best-effort: failures are logged but never block the request path.
 *  - No scheduler, worker, or background lifecycle — runs inline after append.
 *  - A simple per-process flag prevents concurrent/re-entrant truncation.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { renameAtomicFile } from "../lib/windows-atomic-replace";
import { discardRetainedUsageSnapshot } from "./log";

/** Floor: retention limits below this are treated as unconfigured. */
export const MIN_USAGE_LEDGER_MAX_BYTES = 1024 * 1024; // 1 MiB

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

/**
 * Read the ledger backwards to find the newest complete JSONL rows fitting
 * within `maxBytes`, write them to a temp file, and atomically replace.
 */
function truncateUsageLedger(ledgerPath: string, maxBytes: number): void {
  // Read the entire file — we need to find complete line boundaries.
  // The file is larger than maxBytes, so we only need to read the tail.
  let fd: number | undefined;
  try {
    fd = openSync(ledgerPath, "r");
    const stat = fstatSync(fd);
    const fileSize = Number(stat.size);

    if (fileSize <= maxBytes) return;

    // Read the last `maxBytes` bytes to find rows to keep.
    const readSize = Math.min(fileSize, maxBytes);
    const readStart = fileSize - readSize;
    const buffer = Buffer.allocUnsafe(readSize);

    let offset = 0;
    while (offset < readSize) {
      const read = readSync(fd, buffer, offset, readSize - offset, readStart + offset);
      if (read === 0) return; // File changed underneath us; bail
      offset += read;
    }
    closeSync(fd);
    fd = undefined;

    // Find the first complete line boundary in the buffer.
    // If we started mid-file, skip forward to the first newline + 1.
    let contentStart = 0;
    if (readStart > 0) {
      const firstNewline = buffer.indexOf(0x0a); // LF
      if (firstNewline < 0) {
        // The entire tail is one giant line. Keep it as-is (single oversized row).
        contentStart = 0;
      } else {
        contentStart = firstNewline + 1;
      }
    }

    // Validate that we have at least one complete row.
    // A complete row ends with LF. If the buffer has no LF after contentStart,
    // the whole thing is one incomplete line — keep the original file.
    const content = buffer.subarray(contentStart);
    if (content.length === 0) return;

    // Check for incomplete trailing line (no trailing newline).
    // If the file ends with a newline, all rows are complete.
    // If not, we need to strip the partial trailing line.
    let endOffset = content.length;
    if (content[endOffset - 1] !== 0x0a) {
      // Find the last newline — everything after it is an incomplete row.
      const lastNewline = content.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        // No complete row at all. This is a single oversized line.
        // Keep the original file intact rather than producing an empty file.
        return;
      }
      endOffset = lastNewline + 1;
    }

    const retained = content.subarray(0, endOffset);

    // Write to a temp file next to the ledger, then atomic rename.
    const tmpPath = join(dirname(ledgerPath), `.usage-retention-${process.pid}.tmp`);
    try {
      writeFileSync(tmpPath, retained, { mode: 0o600 });
      try { chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }
      renameAtomicFile(tmpPath, ledgerPath, undefined, "usage-ledger-retention");

      // Invalidate in-memory caches so readers re-parse.
      discardRetainedUsageSnapshot();

      // Delete the derived routing-history index so it auto-rebuilds.
      // The indexer detects source identity changes (inode may change on rename)
      // and triggers a full rebuild automatically, but deleting it is explicit
      // and avoids a stale offset pointing past the truncated file.
      deleteRoutingHistoryIndex(ledgerPath);
    } catch {
      // Clean up the temp file on failure.
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      // Failure is tolerated: the ledger is still intact (append succeeded),
      // and the next append will retry truncation.
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
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
