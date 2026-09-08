import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBytes } from "../../format-bytes";
import { useT, type Locale } from "../../i18n/shared";

const MIB = 1024 ** 2;
const PRESETS_MIB = [128, 512, 1024, 2048] as const;

interface RetentionJobState {
  status: "idle" | "running";
  lastOutcome?: {
    ok: boolean;
    skipped?: string;
    deferred?: string;
    error?: string;
    beforeBytes?: number;
    afterBytes?: number;
    droppedBytes?: number;
  };
}

interface RetentionStatus {
  enabled: boolean;
  maxBytes: number;
  currentBytes: number;
  overLimit: boolean;
  job: RetentionJobState;
}

/** Storage-workspace controls for the opt-in usage-ledger byte ceiling. */
export default function UsageLedgerRetentionPanel({
  apiBase,
  locale,
}: {
  apiBase: string;
  locale: Locale;
}) {
  const t = useT();
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [limitMiB, setLimitMiB] = useState(512);
  const [busyAction, setBusyAction] = useState<"save" | "apply" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Refresh policy, byte usage, and current retention-job state from management API. */
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention`, { signal });
    if (!response.ok) throw new Error("load_failed");
    const next = await response.json() as RetentionStatus;
    setStatus(next);
    setEnabled(next.enabled);
    setLimitMiB(Math.max(1, Math.round(next.maxBytes / MIB)));
    return next;
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    // `load` awaits the management API before committing its snapshot, so this
    // is an external subscription update rather than a synchronous render
    // cascade. Keep the initial fetch in the effect to preserve cancellation.
    // eslint-disable-next-line react-hooks/set-state-in-effect, react/react-compiler
    void load(controller.signal).catch(errorValue => {
      if ((errorValue as { name?: string })?.name !== "AbortError") {
        setError(t("storage.usageRetention.error"));
      }
    });
    return () => controller.abort();
  }, [load, t]);

  useEffect(() => {
    if (status?.job.status !== "running") return;
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [load, status?.job.status]);

  const normalizedLimitMiB = useMemo(
    () => Math.max(1, Math.floor(Number.isFinite(limitMiB) ? limitMiB : 1)),
    [limitMiB],
  );
  const hasUnsavedChanges = status !== null && (
    enabled !== status.enabled || normalizedLimitMiB * MIB !== status.maxBytes
  );

  /** Persist policy only; destructive work remains behind scheduler or explicit run. */
  const save = async () => {
    setBusyAction("save");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          maxBytes: normalizedLimitMiB * MIB,
        }),
      });
      if (!response.ok) throw new Error("save_failed");
      const next = await response.json() as RetentionStatus;
      setStatus(next);
      setEnabled(next.enabled);
      setLimitMiB(Math.max(1, Math.round(next.maxBytes / MIB)));
      setMessage(t("storage.usageRetention.saved"));
    } catch {
      setError(t("storage.usageRetention.error"));
    } finally {
      setBusyAction(null);
    }
  };

  /** Request the explicit immediate destructive run, then refresh its job state. */
  const applyNow = async () => {
    if (hasUnsavedChanges) return;
    setBusyAction("apply");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention/run`, {
        method: "POST",
      });
      if (!response.ok && response.status !== 409) throw new Error("run_failed");
      await load();
    } catch {
      setError(t("storage.usageRetention.error"));
    } finally {
      setBusyAction(null);
    }
  };

  const busy = busyAction !== null;
  const jobRunning = status?.job.status === "running";

  return (
    <div className="stw-section" data-testid="usage-ledger-retention">
      <h3 className="stw-section-title">{t("storage.usageRetention.title")}</h3>
      <p className="stw-hint">{t("storage.usageRetention.help")}</p>

      <div className="stw-kv-row">
        <span>{t("storage.usageRetention.current")}</span>
        <span className="stw-kv-mono">
          {status ? formatBytes(status.currentBytes, locale) : "—"}
        </span>
      </div>

      <label className="stw-kv-row" style={{ cursor: busy ? "default" : "pointer" }}>
        <span>{t("storage.usageRetention.enabled")}</span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={event => setEnabled(event.target.checked)}
        />
      </label>

      <div className="stw-kv-row" style={{ alignItems: "center", gap: 12 }}>
        <span>{t("storage.usageRetention.limit")}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <input
            type="number"
            min={1}
            step={1}
            value={limitMiB}
            disabled={busy}
            onChange={event => setLimitMiB(Number(event.target.value))}
            aria-label={t("storage.usageRetention.limit")}
            style={{ width: 96 }}
          />
          <span className="muted mono">{t("storage.usageRetention.unitMiB")}</span>
        </span>
      </div>

      <div className="storage-policy-actions" style={{ flexWrap: "wrap" }}>
        {PRESETS_MIB.map(value => (
          <button
            key={value}
            type="button"
            className={`btn btn-ghost btn-sm${normalizedLimitMiB === value ? " active" : ""}`}
            disabled={busy}
            onClick={() => setLimitMiB(value)}
          >
            {value >= 1024
              ? `${value / 1024} ${t("storage.usageRetention.unitGiB")}`
              : `${value} ${t("storage.usageRetention.unitMiB")}`}
          </button>
        ))}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save()}>
          {busyAction === "save" ? t("storage.usageRetention.saving") : t("storage.usageRetention.save")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || !status?.enabled || jobRunning || hasUnsavedChanges}
          onClick={() => void applyNow()}
        >
          {busyAction === "apply" || jobRunning
            ? t("storage.usageRetention.running")
            : t("storage.usageRetention.apply")}
        </button>
      </div>

      {hasUnsavedChanges && <p className="stw-hint">{t("storage.usageRetention.saveBeforeApply")}</p>}
      {status && !status.enabled && <p className="stw-hint">{t("storage.usageRetention.disabled")}</p>}
      {message && <p className="stw-hint" role="status">{message}</p>}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}
