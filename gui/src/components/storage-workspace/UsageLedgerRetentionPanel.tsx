import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBytes } from "../../format-bytes";
import type { Locale } from "../../i18n/shared";

const MIB = 1024 ** 2;
const PRESETS_MIB = [128, 512, 1024, 2048] as const;

type LabelKey =
  | "title"
  | "help"
  | "enabled"
  | "current"
  | "limit"
  | "save"
  | "apply"
  | "saving"
  | "running"
  | "saved"
  | "disabled"
  | "error";

const EN: Record<LabelKey, string> = {
  title: "Usage history size limit",
  help: "When enabled, OpenCodex keeps the newest complete usage records and permanently removes older rows after the ledger exceeds this limit.",
  enabled: "Limit usage history size",
  current: "Current size",
  limit: "Maximum size",
  save: "Save",
  apply: "Apply now",
  saving: "Saving…",
  running: "Applying…",
  saved: "Saved",
  disabled: "Disabled",
  error: "Could not update the usage history limit.",
};

const ZH: Record<LabelKey, string> = {
  title: "Usage 历史大小限制",
  help: "启用后，OpenCodex 会保留最新的完整 usage 记录，并在日志超过上限后永久删除较旧记录。",
  enabled: "限制 Usage 历史大小",
  current: "当前大小",
  limit: "最大大小",
  save: "保存",
  apply: "立即应用",
  saving: "正在保存…",
  running: "正在应用…",
  saved: "已保存",
  disabled: "已关闭",
  error: "无法更新 Usage 历史大小限制。",
};

function label(locale: Locale, key: LabelKey): string {
  return (locale === "zh" || locale === "zh-TW") ? ZH[key] : EN[key];
}

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

export default function UsageLedgerRetentionPanel({
  apiBase,
  locale,
}: {
  apiBase: string;
  locale: Locale;
}) {
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [limitMiB, setLimitMiB] = useState(512);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    void load(controller.signal).catch(errorValue => {
      if ((errorValue as { name?: string })?.name !== "AbortError") {
        setError(label(locale, "error"));
      }
    });
    return () => controller.abort();
  }, [load, locale]);

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

  const save = async () => {
    setBusy(true);
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
      setMessage(label(locale, "saved"));
    } catch {
      setError(label(locale, "error"));
    } finally {
      setBusy(false);
    }
  };

  const applyNow = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention/run`, {
        method: "POST",
      });
      if (!response.ok && response.status !== 409) throw new Error("run_failed");
      await load();
    } catch {
      setError(label(locale, "error"));
    } finally {
      setBusy(false);
    }
  };

  const jobRunning = status?.job.status === "running";

  return (
    <div className="stw-section" data-testid="usage-ledger-retention">
      <h3 className="stw-section-title">{label(locale, "title")}</h3>
      <p className="stw-hint">{label(locale, "help")}</p>

      <div className="stw-kv-row">
        <span>{label(locale, "current")}</span>
        <span className="stw-kv-mono">
          {status ? formatBytes(status.currentBytes, locale) : "—"}
        </span>
      </div>

      <label className="stw-kv-row" style={{ cursor: busy ? "default" : "pointer" }}>
        <span>{label(locale, "enabled")}</span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={event => setEnabled(event.target.checked)}
        />
      </label>

      <div className="stw-kv-row" style={{ alignItems: "center", gap: 12 }}>
        <span>{label(locale, "limit")}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <input
            type="number"
            min={1}
            step={1}
            value={limitMiB}
            disabled={busy}
            onChange={event => setLimitMiB(Number(event.target.value))}
            aria-label={label(locale, "limit")}
            style={{ width: 96 }}
          />
          <span className="muted mono">MiB</span>
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
            {value >= 1024 ? `${value / 1024} GiB` : `${value} MiB`}
          </button>
        ))}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save()}>
          {busy ? label(locale, "saving") : label(locale, "save")}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || !status?.enabled || jobRunning}
          onClick={() => void applyNow()}
        >
          {jobRunning ? label(locale, "running") : label(locale, "apply")}
        </button>
      </div>

      {status && !status.enabled && <p className="stw-hint">{label(locale, "disabled")}</p>}
      {message && <p className="stw-hint" role="status">{message}</p>}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}
