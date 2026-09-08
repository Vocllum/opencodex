import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBytes } from "../../format-bytes";
import { useI18n } from "../../i18n/shared";
import { Select, Switch } from "../../ui";

const MIB = 1024 ** 2;
const UNLIMITED_OPTION = "unlimited";
const CUSTOM_OPTION = "custom";
const COMMON_LIMITS_MIB = [128, 512, 1024, 2048] as const;

interface RetentionStatus {
  enabled: boolean;
  maxBytes: number;
  currentBytes?: number;
}

function parseStatus(value: unknown): RetentionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_status");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== "boolean" || typeof candidate.maxBytes !== "number"
    || !Number.isFinite(candidate.maxBytes) || candidate.maxBytes <= 0) {
    throw new Error("invalid_status");
  }
  return {
    enabled: candidate.enabled,
    maxBytes: candidate.maxBytes,
    currentBytes: typeof candidate.currentBytes === "number" && Number.isFinite(candidate.currentBytes)
      ? candidate.currentBytes
      : undefined,
  };
}

function limitMiBFromBytes(bytes: number): number | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const value = Math.round(bytes / MIB);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseCustomLimit(raw: string): number | null {
  const value = Number(raw.replace(/[_,\s]/g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Compact Usage-page control for the opt-in usage-ledger byte ceiling.
 *
 * The server status is the only policy source. Selecting Unlimited or a common
 * value persists immediately; Custom is the sole two-step path so an input can
 * be checked before it is sent. The switch is a convenient reflection/shortcut
 * to turn the same `enabled` value off, not a second draft state; bounded values
 * are enabled through the Select so Unlimited remains the only off state.
 */
export default function UsageLedgerRetentionControl({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention`, { signal });
    if (!response.ok) throw new Error("load_failed");
    const next = parseStatus(await response.json());
    if (signal?.aborted) return;
    setStatus(next);
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void load(controller.signal).catch(errorValue => {
        if (!controller.signal.aborted && (errorValue as { name?: string })?.name !== "AbortError") {
          setError(t("usage.retention.error"));
        }
      });
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [load, t]);

  const limitMiB = status ? limitMiBFromBytes(status.maxBytes) : null;
  const enabled = status?.enabled === true;
  // Until GET resolves (and whenever the policy is off), the visible value is
  // explicitly Unlimited. This avoids inventing a 512 MiB default in the UI.
  const selectedValue = !enabled
    ? UNLIMITED_OPTION
    : customOpen
      ? CUSTOM_OPTION
      : limitMiB === null
        ? CUSTOM_OPTION
        : String(limitMiB);
  const commonLimitSet = useMemo(() => new Set<number>(COMMON_LIMITS_MIB), []);
  const options = useMemo(() => [
    { value: UNLIMITED_OPTION, label: t("usage.retention.unlimited") },
    ...(enabled && limitMiB !== null && !commonLimitSet.has(limitMiB) && !customOpen
      ? [{ value: String(limitMiB), label: formatBytes(limitMiB * MIB, locale) }]
      : []),
    ...COMMON_LIMITS_MIB.map(value => ({ value: String(value), label: formatBytes(value * MIB, locale) })),
    { value: CUSTOM_OPTION, label: t("models.custom") },
  ], [commonLimitSet, customOpen, enabled, limitMiB, locale, t]);

  const persist = useCallback(async (nextEnabled: boolean, nextLimitMiB: number) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled, maxBytes: nextLimitMiB * MIB }),
      });
      if (!response.ok) throw new Error("save_failed");
      setStatus(parseStatus(await response.json()));
      setCustomOpen(false);
    } catch {
      setError(t("usage.retention.error"));
    } finally {
      setBusy(false);
    }
  }, [apiBase, t]);

  const switchEnabled = () => {
    if (!status || !enabled || limitMiB === null || busy) return;
    void persist(false, limitMiB);
  };

  const selectLimit = (value: string) => {
    if (!status || busy) return;
    setError(null);
    if (value === UNLIMITED_OPTION) {
      if (enabled && limitMiB !== null) void persist(false, limitMiB);
      return;
    }
    if (value === CUSTOM_OPTION) {
      setCustomOpen(true);
      // A disabled policy is Unlimited, so do not surface the compatibility
      // fallback ceiling as a made-up custom default. Bounded values can still
      // be selected explicitly from the list before opening Custom.
      setCustomDraft(enabled && limitMiB !== null ? String(limitMiB) : "");
      return;
    }
    const nextLimitMiB = parseCustomLimit(value);
    if (nextLimitMiB !== null) void persist(true, nextLimitMiB);
  };

  const applyCustom = () => {
    const nextLimitMiB = parseCustomLimit(customDraft);
    if (nextLimitMiB === null) {
      setError(t("usage.retention.error"));
      return;
    }
    void persist(true, nextLimitMiB);
  };

  const controlsDisabled = busy || status === null || limitMiB === null;

  return (
    <section className="usage-retention-control" data-testid="usage-ledger-retention" aria-labelledby="usage-retention-title">
      <div className="usage-retention-heading">
        <div>
          <h3 id="usage-retention-title" className="h-section">{t("usage.retention.title")}</h3>
          <p className="muted text-control">{t("usage.retention.help")}</p>
        </div>
        <span className="muted text-caption usage-retention-current">
          {t("usage.retention.current")}: {status?.currentBytes === undefined ? "—" : formatBytes(status.currentBytes, locale)}
        </span>
      </div>

      <div className="usage-retention-controls" aria-busy={busy}>
        <Switch
          on={enabled}
          onClick={switchEnabled}
          disabled={controlsDisabled || !enabled}
          label={t("usage.retention.enabled")}
          showLabel
        />
        <span className="muted text-control">{t("usage.retention.limit")}</span>
        <Select
          value={selectedValue}
          options={options}
          onChange={selectLimit}
          disabled={controlsDisabled}
          label={t("usage.retention.limit")}
        />
        {customOpen && (
          <>
            <input
              className="input usage-retention-custom-input"
              inputMode="numeric"
              min={1}
              step={1}
              type="number"
              value={customDraft}
              onChange={event => setCustomDraft(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") applyCustom(); }}
              disabled={busy}
              aria-label={t("usage.retention.limit")}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={applyCustom} disabled={busy}>
              {busy ? t("common.saving") : t("models.customApply")}
            </button>
          </>
        )}
      </div>

      {!enabled && status && <p className="muted text-caption">{t("usage.retention.disabled")}</p>}
      {error && <p className="err" role="alert">{error}</p>}
    </section>
  );
}
