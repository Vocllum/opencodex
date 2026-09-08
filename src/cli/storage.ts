/**
 * `ocx storage` — the archived-session cleanup, trash, cleanup-policy, and usage-ledger surface.
 *
 * Destructive actions are explicit. Session cleanup defaults to preview, restores require
 * confirmation, and a manual usage-ledger trim requires --yes because it permanently drops
 * older request-history rows.
 */
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const MIB = 1024 * 1024;

const USAGE = `Usage:
  ocx storage report [--json]
  ocx storage cleanup --percent <0-100> [--mode <quarantine|permanent>] [--yes] [--json]
  ocx storage trash [list] [--json]
  ocx storage trash restore <entry-id> [--yes] [--json]
  ocx storage policy [show] [--json]
  ocx storage policy set [--enabled <true|false>] [--percent <0-100>]
      [--mode <quarantine|permanent>] [--schedule <startup|daily|weekly|manual>] [--json]
  ocx storage policy run [--yes] [--json]
  ocx storage usage-limit [show] [--json]
  ocx storage usage-limit set [--enabled <true|false>] [--mib <N>] [--json]
  ocx storage usage-limit run [--yes] [--json]

Cleanup, restore, and usage-limit run MUTATE operator data and require --yes where noted.
Without --yes, cleanup prints the preview and changes nothing.`;

/** The digest binds a run to the preview it was authorized against. */
interface CleanupPreview {
  percent?: number;
  count?: number;
  bytes?: number;
  digest?: string;
  candidates?: { relPath?: string; bytes?: number }[];
}

function mib(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "unknown size";
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function previewLines(preview: CleanupPreview): string[] {
  const lines = [
    `Would remove ${preview.count ?? 0} archived session file(s), freeing ${mib(preview.bytes)}.`,
  ];
  for (const candidate of (preview.candidates ?? []).slice(0, 10)) {
    lines.push(`  ${candidate.relPath ?? "(unnamed)"}  ${mib(candidate.bytes)}`);
  }
  const shown = Math.min((preview.candidates ?? []).length, 10);
  if ((preview.count ?? 0) > shown) lines.push(`  … and ${(preview.count ?? 0) - shown} more`);
  lines.push("Nothing was deleted. Re-run with --yes to apply.");
  return lines;
}

async function cleanup(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const confirmed = takeFlag(args, "--yes");
  const percent = takeIntegerOption(args, "--percent", { min: 0 });
  const mode = takeOption(args, "--mode") ?? "quarantine";
  rejectArgs(args, USAGE);

  if (percent === undefined) throw new CliUsageError("--percent is required", USAGE);
  if (percent > 100) throw new CliUsageError("--percent must be between 0 and 100", USAGE);
  if (mode !== "quarantine" && mode !== "permanent") {
    throw new CliUsageError("--mode must be quarantine or permanent", USAGE);
  }

  // The preview runs in BOTH paths, and not only to be friendly: the mutating route requires the
  // digest this call returns and rejects a stale one with 409 `stale_preview`. So the confirmed
  // path cannot skip it, which conveniently means --yes and no --yes agree on what they mean.
  const preview = await runtimeRequest<CleanupPreview>("/api/storage/cleanup/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ percent }),
  }, deps);

  if (!confirmed) {
    printData(preview, wantsJson, previewLines(preview));
    return;
  }

  if (!preview.digest) {
    throw new CliUsageError("the preview returned no digest, so the cleanup cannot be authorized", USAGE);
  }

  const result = await runtimeRequest("/api/storage/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ percent, mode, digest: preview.digest }),
  }, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function trash(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const action = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  if (action === "list") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/storage/trash", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }

  if (action !== "restore") throw new CliUsageError(`unknown trash action ${action}`, USAGE);

  const args = [...rest];
  const wantsJson = takeFlag(args, "--json");
  const confirmed = takeFlag(args, "--yes");
  const id = args.shift();
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("a trash entry id is required", USAGE);

  if (!confirmed) {
    throw new CliUsageError(`restoring ${id} modifies stored sessions; pass --yes to confirm`, USAGE);
  }

  const result = await runtimeRequest("/api/storage/trash/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function policy(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const action = argv[0] && !argv[0].startsWith("-") ? argv[0] : "show";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  if (action === "show") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/storage/cleanup-policy", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }

  if (action === "set") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    const enabled = takeOption(args, "--enabled");
    const percent = takeIntegerOption(args, "--percent", { min: 0 });
    const mode = takeOption(args, "--mode");
    const schedule = takeOption(args, "--schedule");
    rejectArgs(args, USAGE);

    if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
      throw new CliUsageError("--enabled must be true or false", USAGE);
    }
    const body: Record<string, unknown> = {};
    if (enabled !== undefined) body.enabled = enabled === "true";
    if (percent !== undefined) body.target = { removeOldestPercent: percent };
    if (mode !== undefined) body.mode = mode;
    if (schedule !== undefined) body.schedule = schedule;
    if (Object.keys(body).length === 0) {
      throw new CliUsageError("policy set needs at least one of --enabled, --percent, --mode, --schedule", USAGE);
    }
    const result = await runtimeRequest("/api/storage/cleanup-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }

  if (action !== "run") throw new CliUsageError(`unknown policy action ${action}`, USAGE);

  const args = [...rest];
  const wantsJson = takeFlag(args, "--json");
  const confirmed = takeFlag(args, "--yes");
  rejectArgs(args, USAGE);
  if (!confirmed) {
    throw new CliUsageError("policy run deletes archived sessions now; pass --yes to confirm", USAGE);
  }
  const result = await runtimeRequest("/api/storage/cleanup-policy/run", { method: "POST" }, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function usageLimit(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const action = argv[0] && !argv[0].startsWith("-") ? argv[0] : "show";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  if (action === "show") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/storage/usage-ledger-retention", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }

  if (action === "set") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    const enabled = takeOption(args, "--enabled");
    const maxMiB = takeIntegerOption(args, "--mib", { min: 1 });
    rejectArgs(args, USAGE);

    if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
      throw new CliUsageError("--enabled must be true or false", USAGE);
    }
    if (maxMiB !== undefined && !Number.isSafeInteger(maxMiB * MIB)) {
      throw new CliUsageError("--mib is too large", USAGE);
    }
    const body: Record<string, unknown> = {};
    if (enabled !== undefined) body.enabled = enabled === "true";
    if (maxMiB !== undefined) body.maxBytes = maxMiB * MIB;
    if (Object.keys(body).length === 0) {
      throw new CliUsageError("usage-limit set needs at least one of --enabled or --mib", USAGE);
    }

    const result = await runtimeRequest("/api/storage/usage-ledger-retention", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }

  if (action !== "run") throw new CliUsageError(`unknown usage-limit action ${action}`, USAGE);
  const args = [...rest];
  const wantsJson = takeFlag(args, "--json");
  const confirmed = takeFlag(args, "--yes");
  rejectArgs(args, USAGE);
  if (!confirmed) {
    throw new CliUsageError("usage-limit run permanently removes older usage history; pass --yes to confirm", USAGE);
  }
  const result = await runtimeRequest("/api/storage/usage-ledger-retention/run", { method: "POST" }, deps);
  printData(result, wantsJson, summaryLines(result));
}

export async function handleStorageCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const hasSub = argv[0] !== undefined && !argv[0].startsWith("-");
  const sub = hasSub ? argv[0]! : "report";
  const rest = hasSub ? argv.slice(1) : argv;
  if (sub === "codex-logs") {
    const { handleObserveCommand } = await import("./observe");
    return handleObserveCommand(["storage", "codex-logs", ...rest], deps);
  }
  return runCliAction(async () => {
    if (sub === "report") {
      const args = [...rest];
      const wantsJson = takeFlag(args, "--json");
      rejectArgs(args, USAGE);
      const result = await runtimeRequest("/api/storage", {}, deps);
      printData(result, wantsJson, summaryLines(result));
    }
    else if (sub === "cleanup") await cleanup(rest, deps);
    else if (sub === "trash") await trash(rest, deps);
    else if (sub === "policy") await policy(rest, deps);
    else if (sub === "usage-limit") await usageLimit(rest, deps);
    else throw new CliUsageError(`unknown storage command ${sub}`, USAGE);
  });
}

export const STORAGE_USAGE = USAGE;
