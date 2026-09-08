import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardRequestHistoryProjection } from "../src/routing/history/discard-index";
import { historyIndexPath } from "../src/routing/history/schema";
import {
  DEFAULT_USAGE_LEDGER_MAX_BYTES,
  MIN_USAGE_LEDGER_MAX_BYTES,
  normalizeUsageLedgerRetention,
  prepareUsageLedgerCompaction,
  usageLedgerRevisionMatches,
} from "../src/usage/ledger-retention";
import { parseUsageLedgerRetentionInput } from "../src/usage/ledger-retention-config";
import {
  commitPreparedUsageLedgerCompaction,
  getUsageLedgerRetentionJobState,
  invalidateUsageLedgerRetentionRun,
  requestUsageLedgerRetentionRun,
  resetUsageLedgerRetentionJobForTests,
} from "../src/usage/ledger-retention-job";
import { getConfigPath, getDefaultConfig, saveConfig } from "../src/config";

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

afterEach(async () => {
  await resetUsageLedgerRetentionJobForTests();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitForRetentionIdle(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getUsageLedgerRetentionJobState().status === "idle") return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for usage ledger retention job");
}

describe("usage ledger retention v2", () => {
  test("missing or unknown persisted config keys stay Unlimited", () => {
    expect(normalizeUsageLedgerRetention(undefined).enabled).toBe(false);
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
    for (const maxBytes of [Number.MAX_SAFE_INTEGER + 1, MIN_USAGE_LEDGER_MAX_BYTES - 1, MIN_USAGE_LEDGER_MAX_BYTES + 0.5]) {
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

  test("discards the derived request-history database and sidecars from an isolated config home", () => {
    const dir = home();
    const path = historyIndexPath(dir);
    writeFileSync(path, "main");
    writeFileSync(`${path}-wal`, "wal");
    writeFileSync(`${path}-shm`, "shm");

    expect(discardRequestHistoryProjection(dir)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
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

  test("closes the derived history index before replace and discards it only after publication", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");
    const expected = readFileSync(prepared.tempPath, "utf8");
    let closed = false;
    let replaced = false;
    let discarded = false;

    const result = commitPreparedUsageLedgerCompaction(prepared, {
      activeTurnCount: () => 0,
      closeHistoryIndex: () => { closed = true; },
      rename: (from, to) => {
        expect(closed).toBe(true);
        renameSync(from, to);
        replaced = true;
      },
      discardHistoryProjection: configDir => {
        expect(replaced).toBe(true);
        expect(configDir).toBe(dir);
        discarded = true;
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.droppedBytes).toBeGreaterThan(0);
    expect(discarded).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(expected);
  });

  test("derived projection cleanup failure does not reverse a successful canonical commit", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    writeFileSync(path, old + latest);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");
    const expected = readFileSync(prepared.tempPath, "utf8");
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const result = commitPreparedUsageLedgerCompaction(prepared, {
        activeTurnCount: () => 0,
        rename: renameSync,
        discardHistoryProjection: () => { throw new Error("projection busy"); },
      });
      expect(result.ok).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(expected);
    } finally {
      console.warn = warn;
    }
  });

  test("does not discard the derived projection when canonical publication fails", () => {
    const dir = home();
    const path = join(dir, "usage.jsonl");
    const old = `${JSON.stringify({ requestId: "old", filler: "a".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n`;
    const latest = `${JSON.stringify({ requestId: "new" })}\n`;
    const original = old + latest;
    writeFileSync(path, original);
    const prepared = prepareUsageLedgerCompaction(path, MIN_USAGE_LEDGER_MAX_BYTES);
    if (!prepared.changed) throw new Error("expected compaction");
    let discarded = false;

    const result = commitPreparedUsageLedgerCompaction(prepared, {
      activeTurnCount: () => 0,
      closeHistoryIndex: () => undefined,
      rename: () => { throw new Error("rename failed"); },
      discardHistoryProjection: () => {
        discarded = true;
        return true;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("commit_failed");
    expect(discarded).toBe(false);
    expect(existsSync(prepared.tempPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("invalidating a policy generation prevents a prepared Worker candidate from publishing", async () => {
    const dir = home();
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      const maxBytes = MIN_USAGE_LEDGER_MAX_BYTES;
      const config = {
        ...getDefaultConfig(),
        usageLedgerRetention: { enabled: true, maxBytes },
      };
      saveConfig(config);

      const path = join(dir, "usage.jsonl");
      const original = jsonlRowOfSize("old", maxBytes) + jsonlRowOfSize("new", 256);
      writeFileSync(path, original);

      const started = requestUsageLedgerRetentionRun();
      expect(started.accepted).toBe(true);
      // The generation is invalidated while the Worker is still preparing its read-only
      // candidate. The stale result must be discarded before the atomic publish step.
      invalidateUsageLedgerRetentionRun();
      await waitForRetentionIdle();

      expect(readFileSync(path, "utf8")).toBe(original);
      expect(getUsageLedgerRetentionJobState().lastOutcome).toBeUndefined();
      expect(readdirSync(dir).filter(name => name.includes(".retention-")).length).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      // Keep the config path import exercised against the isolated home and ensure no
      // accidental write escaped into the test process's default configuration.
      expect(getConfigPath()).not.toBe(join(dir, "config.json"));
    }
  });
});
