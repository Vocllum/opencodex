import { describe, expect, test } from "bun:test";
import { handleStorageCommand } from "../../src/cli/storage";

interface Call { method: string; path: string; body: unknown }

function harness(respond: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const call = {
      method: init?.method ?? "GET",
      path: parsed.pathname + parsed.search,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const { status = 200, json } = respond(call);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, deps: { baseUrl: "http://cli.test", fetchImpl } };
}

function capture(): { restore: () => void } {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  return { restore: () => { console.log = log; console.error = error; } };
}

const STATUS = {
  enabled: false,
  maxBytes: 512 * 1024 * 1024,
  currentBytes: 64 * 1024 * 1024,
  overLimit: false,
  job: { status: "idle" },
};

describe("ocx storage usage-limit", () => {
  test("show reads the usage-ledger retention status", async () => {
    const { calls, deps } = harness(() => ({ json: STATUS }));
    const cap = capture();
    try {
      expect(await handleStorageCommand(["usage-limit", "show"], deps)).toBe(0);
    } finally {
      cap.restore();
    }
    expect(calls).toEqual([{ method: "GET", path: "/api/storage/usage-ledger-retention", body: undefined }]);
  });

  test("set sends only the fields explicitly given", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true, ...STATUS } }));
    const cap = capture();
    try {
      expect(await handleStorageCommand(["usage-limit", "set", "--mib", "1024"], deps)).toBe(0);
    } finally {
      cap.restore();
    }
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/storage/usage-ledger-retention",
      body: { maxBytes: 1024 * 1024 * 1024 },
    });
    expect(calls[0]?.body).not.toHaveProperty("enabled");
  });

  test("set can explicitly enable without changing the saved ceiling", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true, ...STATUS, enabled: true } }));
    const cap = capture();
    try {
      expect(await handleStorageCommand(["usage-limit", "set", "--enabled", "true"], deps)).toBe(0);
    } finally {
      cap.restore();
    }
    expect(calls[0]?.body).toEqual({ enabled: true });
  });

  test("set with no fields is rejected locally", async () => {
    const { calls, deps } = harness(() => ({ json: STATUS }));
    const cap = capture();
    let code: number;
    try {
      code = await handleStorageCommand(["usage-limit", "set"], deps);
    } finally {
      cap.restore();
    }
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("manual run requires --yes and sends no mutation without it", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true, started: true } }));
    const cap = capture();
    let code: number;
    try {
      code = await handleStorageCommand(["usage-limit", "run"], deps);
    } finally {
      cap.restore();
    }
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("manual run with --yes reaches the destructive route", async () => {
    const { calls, deps } = harness(() => ({ json: { ok: true, started: true } }));
    const cap = capture();
    try {
      expect(await handleStorageCommand(["usage-limit", "run", "--yes"], deps)).toBe(0);
    } finally {
      cap.restore();
    }
    expect(calls).toEqual([{ method: "POST", path: "/api/storage/usage-ledger-retention/run", body: undefined }]);
  });
});
