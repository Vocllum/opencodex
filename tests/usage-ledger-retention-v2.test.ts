import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_USAGE_LEDGER_MAX_BYTES,
  MIN_USAGE_LEDGER_MAX_BYTES,
  normalizeUsageLedgerRetention,
  prepareUsageLedgerCompaction,
  usageLedgerRevisionMatches,
} from "../src/usage/ledger-retention";

const homes: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-ledger-retention-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("usage ledger retention v2", () => {
  test("unknown config keys disable destructive retention", () => {
    expect(normalizeUsageLedgerRetention({ enabled: true, maxByets: 8 * 1024 * 1024 })).toEqual({
      enabled: false,
      maxBytes: DEFAULT_USAGE_LEDGER_MAX_BYTES,
    });
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

  test("drops an unterminated crash tail", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const filler = "x".repeat(MIN_USAGE_LEDGER_MAX_BYTES);
    const complete = `${JSON.stringify({ requestId: "complete", filler })}\n`;
    const partial = JSON.stringify({ requestId: "partial", filler: "y".repeat(1024) });
    writeFileSync(path, complete + partial);

    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) throw new Error("expected compaction");
    const retained = readFileSync(prepared.tempPath, "utf8");
    expect(retained.endsWith("\n")).toBe(true);
    expect(retained).not.toContain("partial");
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

  test("revision comparator detects a source mutation before commit", () => {
    const revision = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
    expect(usageLedgerRevisionMatches(revision, revision)).toBe(true);
    expect(usageLedgerRevisionMatches(revision, { ...revision, size: 4 })).toBe(false);
  });
});
