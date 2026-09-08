import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "../../format-bytes";
import { useI18n } from "../../i18n/shared";
import { Switch } from "../../ui";

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

/**
 * Minimal Usage-page toggle for the opt-in usage-ledger byte ceiling.
 *
 * The concrete ceiling remains an API/CLI setting. The dashboard only enables or
 * disables the exact value already reported by the server, so a non-MiB-aligned
 * value can never be rounded or silently rewritten by the UI.
 */
export default function UsageLedgerRetentionControl({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    try {
      const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention`, { signal });
      if (!response.ok) throw new Error("load_failed");
      const next = parseStatus(await response.json());
      if (signal?.aborted || generation !== loadGeneration.current) return;
      setError(null);
      setStatus(next);
    } catch (errorValue) {
      // A successful PUT invalidates reads that started under the old policy. Stale reads
      // must be silent whether they eventually succeed, fail HTTP, reject, or parse badly.
      if (signal?.aborted || generation !== loadGeneration.current
        || (errorValue as { name?: string })?.name === "AbortError") return;
      throw errorValue;
    }
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

  const persist = useCallback(async (nextEnabled: boolean, maxBytes: number) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/storage/usage-ledger-retention`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled, maxBytes }),
      });
      if (!response.ok) throw new Error("save_failed");
      const next = parseStatus(await response.json());
      // A GET may have started before this authoritative mutation completed (for example,
      // after a locale change). Do not let that older snapshot repaint the saved state.
      loadGeneration.current += 1;
      setStatus(next);
    } catch {
      setError(t("usage.retention.error"));
    } finally {
      setBusy(false);
    }
  }, [apiBase, t]);

  const toggle = () => {
    if (!status || busy) return;
    void persist(!status.enabled, status.maxBytes);
  };

  return (
    <section className="usage-retention-control" data-testid="usage-ledger-retention" aria-labelledby="usage-retention-title">
      <div className="usage-retention-heading">
        <div>
          <h3 id="usage-retention-title" className="h-section">{t("usage.retention.title")}</h3>
          <p className="muted text-control">{t("usage.retention.help")}</p>
        </div>
        <Switch
          on={status?.enabled === true}
          onClick={toggle}
          disabled={busy || status === null}
          label={t("usage.retention.enabled")}
        />
      </div>

      <p className="muted text-caption usage-retention-current">
        {t("usage.retention.current")}: {status?.currentBytes === undefined ? "—" : formatBytes(status.currentBytes, locale)}
        {status && (
          <>
            {" · "}
            {!status.enabled && <><span className="usage-retention-state">{t("usage.retention.unlimited")}</span>{" · "}</>}
            <span className={`usage-retention-limit${status.enabled ? "" : " is-disabled"}`}>
              {t("usage.retention.limit")}: {formatBytes(status.maxBytes, locale)}
            </span>
          </>
        )}
      </p>
      {error && <p className="err" role="alert">{error}</p>}
    </section>
  );
}
