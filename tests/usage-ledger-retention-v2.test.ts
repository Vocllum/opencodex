import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_USAGE_LEDGER_MAX_BYTES,
  MIN_USAGE_LEDGER_MAX_BYTES,
  normalizeUsageLedgerRetention,
  prepareUsageLedgerCompaction,
  usageLedgerRevisionMatches,
} from "../src/usage/ledger-retention";
import { parseUsageLedgerRetentionInput } from "../src/usage/ledger-retention-config";
import { commitPreparedUsageLedgerCompaction } from "../src/usage/ledger-retention-job";

const homes: string[] = [];

/** Allocate one isolated filesystem home and remember it for teardown. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-ledger-retention-"));
  homes.push(dir);
  return dir;
}

/** Build one JSONL row whose encoded byte length is exactly `totalBytes`. */
function jsonlRowOfSize(requestId: string, totalBytes: number, fill = "x"): string {
  const empty = `${JSON.stringify({ requestId, filler: "" })}\n`;
  const overhead = Buffer.byteLength(empty);
  if (totalBytes < overhead) throw new Error("row target is smaller than JSONL overhead");
  const row = `${JSON.stringify({ requestId, filler: fill.repeat(totalBytes - overhead) })}\n`;
  if (Buffer.byteLength(row) !== totalBytes) throw new Error("row byte sizing drifted");
  return row;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("usage ledger retention v2", () => {
  test("unknown persisted config keys disable destructive retention", () => {
    expect(normalizeUsageLedgerRetention({ enabled: true, maxByets: 8 * 1024 * 1024 })).toEqual({
      enabled: false,
      maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES,
    });
  });

  test("live writes reject unknown config keys instead of silently stripping them", () => {
    const parsed = parseUsageLedgerRetentionInput(
      { enabled: true, maxByets: 8 * 1024 * 1024 },
      { enabled: false, maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected strict parser failure");
    expect(parsed.error).toContain("maxByets");
  });

  test("partial live writes preserve the previous enabled state", () => {
    const maxBytes = 8 * 1024 * 1024;
    expect(parseUsageLedgerRetentionInput(
      { maxBytes },
      { enabled: true, maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES },
    )).toEqual({ ok: true, policy: { enabled: true, maxBytes } });
  });

  test("unsafe or below-floor byte limits disable destructive retention", () => {
    for (const maxBytes of [Number.MAX_SAFE_INTEGER + 1, MIN_USAGE_LEDGER_MAX_BYTES - 1, 1.5 * MIN_USAGE_LEDGER_MAX_BYTES]) {
      expect(normalizeUsageLedgerRetention({ enabled: true, maxBytes }).enabled).toBe(false);
    }
  });

  test("normalizes an explicitly enabled safe byte limit", () => {
    const maxBytes = 8 * 1024 * 1024;
    expect(normalizeUsageLedgerRetention({ enabled: true, maxBytes })).toEqual({ enabled: true, maxBytes });
  });

  test("drops an oversized single row instead of retaining a partial JSONL fragment", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const huge = `${JSON.stringify({ requestId: "huge", payload: "x".repeat(MIN_USAGE_LEDGER_MAX_BYTES + 1024) })}\n`;
    writeFileSync(path, huge);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    expect(prepared.afterBytes).toBe(0);
    expect(readFileSync(prepared.tempPath, "utf8")).toBe("");
  });

  test("drops an unterminated crash tail while retaining a complete row at the ceiling", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const complete = jsonlRowOfSize("complete", MIN_USAGE_LEDGER_MAX_BYTES);
    const partial = JSON.stringify({ requestId: "partial", filler: "y".repeat(1024) });
    writeFileSync(path, complete + partial);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    const retained = readFileSync(prepared.tempPath, "utf8");
    expect(retained).toBe(complete);
    expect(retained.endsWith("\n")).toBe(true);
    expect(retained).not.toContain("partial");
  });

  test("retains the row when the byte ceiling lands exactly on its start boundary", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old" })}\n`;
    const newest = jsonlRowOfSize("new", MIN_USAGE_LEDGER_MAX_BYTES, "b");
    writeFileSync(path, old + newest);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    expect(prepared.afterBytes).toBe(MIN_USAGE_LEDGER_MAX_BYTES);
    expect(readFileSync(prepared.tempPath, "utf8")).toBe(newest);
  });

  test("never starts the candidate in the middle of a long row", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const first = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES + 128) })}\n`;
    const second = `${JSON.stringify({ requestId: "new", filler: "b".repeat(64 * 1024) })}\n`;
    writeFileSync(path, first + second);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    const retained = readFileSync(prepared.tempPath, "utf8");
    expect(retained).toBe(second);
    expect(() => JSON.parse(retained.trim())).not.toThrow();
  });

  test("uses a parent-owned candidate path when one is supplied", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const tempPath = join(dir, "owned-retention.tmp");
    writeFileSync(path, jsonlRowOfSize("old", MIN_USAGE_LEDGER_MAX_BYTES) + `${JSON.stringify({ requestId: "new" })}\n`);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES, tempPath);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    expect(prepared.tempPath).toBe(tempPath);
    expect(existsSync(tempPath)).toBe(true);
  });

  test("revision comparator detects a source mutation before commit", () => {
    const revision = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
    expect(usageLedgerRevisionMatches(revision, revision)).toBe(true);
    expect(usageLedgerRevisionMatches(revision, { ...revision, size: 4 })).toBe(false);
  });

  test("defers commit while a request turn is active and discards the candidate", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");

    const result = commitPreparedUsageLedgerCompaction(prepared, { activeTurnCount: () => 1 });
    expect(result.deferred).toBe("active_turns");
    expect(existsSync(prepared.tempPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(old + latest);
  });

  test("does not overwrite an append that landed after Worker preparation", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");

    const appended = `${JSON.stringify({ requestId: "after-prepare" })}\n`;
    appendFileSync(path, appended);
    const result = commitPreparedUsageLedgerCompaction(prepared, { activeTurnCount: () => 0 });
    expect(result.deferred).toBe("source_changed");
    expect(existsSync(prepared.tempPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(old + latest + appended);
  });

  test("closes the derived history index before replacing an unchanged ledger", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");
    const expected = readFileSync(prepared.tempPath, "utf8");
    let closed = false;

    const result = commitPreparedUsageLedgerCompaction(prepared, {
      activeTurnCount: () => 0,
      closeHistoryIndex: () => { closed = true; },
      rename: (from, to) => {
        expect(closed).toBe(true);
        const { renameSync } = require("node:fs") as typeof import("node:fs");
        renameSync(from, to);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.droppedBytes).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toBe(expected);
  });
});
