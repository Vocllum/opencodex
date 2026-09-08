import type { LabLocale } from "./lab-translations";

export type UsageRetentionCatalogKey =
  | "storage.usageRetention.title"
  | "storage.usageRetention.help"
  | "storage.usageRetention.enabled"
  | "storage.usageRetention.current"
  | "storage.usageRetention.limit"
  | "storage.usageRetention.unitMiB"
  | "storage.usageRetention.unitGiB"
  | "storage.usageRetention.save"
  | "storage.usageRetention.apply"
  | "storage.usageRetention.saving"
  | "storage.usageRetention.running"
  | "storage.usageRetention.saved"
  | "storage.usageRetention.saveBeforeApply"
  | "storage.usageRetention.disabled"
  | "storage.usageRetention.error";

const en: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "Usage history size limit",
  "storage.usageRetention.help": "When enabled, OpenCodex keeps the newest complete usage records and permanently removes older rows after the ledger exceeds this limit.",
  "storage.usageRetention.enabled": "Limit usage history size",
  "storage.usageRetention.current": "Current size",
  "storage.usageRetention.limit": "Maximum size",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "Save",
  "storage.usageRetention.apply": "Apply now",
  "storage.usageRetention.saving": "Saving…",
  "storage.usageRetention.running": "Applying…",
  "storage.usageRetention.saved": "Saved",
  "storage.usageRetention.saveBeforeApply": "Save these changes before applying the limit now.",
  "storage.usageRetention.disabled": "Disabled",
  "storage.usageRetention.error": "Could not update the usage history limit.",
};

const de: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "Größenlimit für Nutzungsverlauf",
  "storage.usageRetention.help": "Wenn aktiviert, behält OpenCodex die neuesten vollständigen Nutzungsdatensätze und entfernt ältere Einträge dauerhaft, sobald das Limit überschritten wird.",
  "storage.usageRetention.enabled": "Größe des Nutzungsverlaufs begrenzen",
  "storage.usageRetention.current": "Aktuelle Größe",
  "storage.usageRetention.limit": "Maximale Größe",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "Speichern",
  "storage.usageRetention.apply": "Jetzt anwenden",
  "storage.usageRetention.saving": "Wird gespeichert…",
  "storage.usageRetention.running": "Wird angewendet…",
  "storage.usageRetention.saved": "Gespeichert",
  "storage.usageRetention.saveBeforeApply": "Speichern Sie diese Änderungen, bevor Sie das Limit sofort anwenden.",
  "storage.usageRetention.disabled": "Deaktiviert",
  "storage.usageRetention.error": "Das Größenlimit für den Nutzungsverlauf konnte nicht aktualisiert werden.",
};

const fr: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "Limite de taille de l’historique d’utilisation",
  "storage.usageRetention.help": "Lorsque cette option est activée, OpenCodex conserve les enregistrements d’utilisation complets les plus récents et supprime définitivement les plus anciens lorsque la limite est dépassée.",
  "storage.usageRetention.enabled": "Limiter la taille de l’historique d’utilisation",
  "storage.usageRetention.current": "Taille actuelle",
  "storage.usageRetention.limit": "Taille maximale",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "Enregistrer",
  "storage.usageRetention.apply": "Appliquer maintenant",
  "storage.usageRetention.saving": "Enregistrement…",
  "storage.usageRetention.running": "Application…",
  "storage.usageRetention.saved": "Enregistré",
  "storage.usageRetention.saveBeforeApply": "Enregistrez ces modifications avant d’appliquer la limite maintenant.",
  "storage.usageRetention.disabled": "Désactivé",
  "storage.usageRetention.error": "Impossible de mettre à jour la limite de l’historique d’utilisation.",
};

const ko: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "사용 기록 크기 제한",
  "storage.usageRetention.help": "활성화하면 OpenCodex는 가장 최근의 완전한 사용 기록을 유지하고 원장이 제한을 초과하면 오래된 행을 영구 삭제합니다.",
  "storage.usageRetention.enabled": "사용 기록 크기 제한",
  "storage.usageRetention.current": "현재 크기",
  "storage.usageRetention.limit": "최대 크기",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "저장",
  "storage.usageRetention.apply": "지금 적용",
  "storage.usageRetention.saving": "저장 중…",
  "storage.usageRetention.running": "적용 중…",
  "storage.usageRetention.saved": "저장됨",
  "storage.usageRetention.saveBeforeApply": "지금 제한을 적용하기 전에 변경 사항을 저장하세요.",
  "storage.usageRetention.disabled": "비활성화됨",
  "storage.usageRetention.error": "사용 기록 크기 제한을 업데이트할 수 없습니다.",
};

const zh: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "Usage 历史大小限制",
  "storage.usageRetention.help": "启用后，OpenCodex 会保留最新的完整 Usage 记录，并在日志超过上限后永久删除较旧记录。",
  "storage.usageRetention.enabled": "限制 Usage 历史大小",
  "storage.usageRetention.current": "当前大小",
  "storage.usageRetention.limit": "最大大小",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "保存",
  "storage.usageRetention.apply": "立即应用",
  "storage.usageRetention.saving": "正在保存…",
  "storage.usageRetention.running": "正在应用…",
  "storage.usageRetention.saved": "已保存",
  "storage.usageRetention.saveBeforeApply": "请先保存这些改动，再立即应用限制。",
  "storage.usageRetention.disabled": "已关闭",
  "storage.usageRetention.error": "无法更新 Usage 历史大小限制。",
};

const zhTW: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "Usage 歷史大小限制",
  "storage.usageRetention.help": "啟用後，OpenCodex 會保留最新的完整 Usage 記錄，並在日誌超過上限後永久刪除較舊記錄。",
  "storage.usageRetention.enabled": "限制 Usage 歷史大小",
  "storage.usageRetention.current": "目前大小",
  "storage.usageRetention.limit": "最大大小",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "儲存",
  "storage.usageRetention.apply": "立即套用",
  "storage.usageRetention.saving": "正在儲存…",
  "storage.usageRetention.running": "正在套用…",
  "storage.usageRetention.saved": "已儲存",
  "storage.usageRetention.saveBeforeApply": "請先儲存這些變更，再立即套用限制。",
  "storage.usageRetention.disabled": "已關閉",
  "storage.usageRetention.error": "無法更新 Usage 歷史大小限制。",
};

const ru: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "Ограничение размера истории использования",
  "storage.usageRetention.help": "Если включено, OpenCodex сохраняет самые новые полные записи использования и безвозвратно удаляет старые строки после превышения лимита.",
  "storage.usageRetention.enabled": "Ограничить размер истории использования",
  "storage.usageRetention.current": "Текущий размер",
  "storage.usageRetention.limit": "Максимальный размер",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "Сохранить",
  "storage.usageRetention.apply": "Применить сейчас",
  "storage.usageRetention.saving": "Сохранение…",
  "storage.usageRetention.running": "Применение…",
  "storage.usageRetention.saved": "Сохранено",
  "storage.usageRetention.saveBeforeApply": "Сохраните изменения перед немедленным применением лимита.",
  "storage.usageRetention.disabled": "Отключено",
  "storage.usageRetention.error": "Не удалось обновить ограничение размера истории использования.",
};

const ja: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "使用履歴のサイズ上限",
  "storage.usageRetention.help": "有効にすると、OpenCodex は最新の完全な使用記録を保持し、台帳が上限を超えた場合に古い行を完全に削除します。",
  "storage.usageRetention.enabled": "使用履歴のサイズを制限",
  "storage.usageRetention.current": "現在のサイズ",
  "storage.usageRetention.limit": "最大サイズ",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "保存",
  "storage.usageRetention.apply": "今すぐ適用",
  "storage.usageRetention.saving": "保存中…",
  "storage.usageRetention.running": "適用中…",
  "storage.usageRetention.saved": "保存しました",
  "storage.usageRetention.saveBeforeApply": "今すぐ上限を適用する前に、この変更を保存してください。",
  "storage.usageRetention.disabled": "無効",
  "storage.usageRetention.error": "使用履歴のサイズ上限を更新できませんでした。",
};

const tr: Record<UsageRetentionCatalogKey, string> = {
  "storage.usageRetention.title": "Kullanım geçmişi boyut sınırı",
  "storage.usageRetention.help": "Etkinleştirildiğinde OpenCodex en yeni eksiksiz kullanım kayıtlarını tutar ve günlük sınırı aştığında eski satırları kalıcı olarak siler.",
  "storage.usageRetention.enabled": "Kullanım geçmişi boyutunu sınırla",
  "storage.usageRetention.current": "Geçerli boyut",
  "storage.usageRetention.limit": "Maksimum boyut",
  "storage.usageRetention.unitMiB": "MiB",
  "storage.usageRetention.unitGiB": "GiB",
  "storage.usageRetention.save": "Kaydet",
  "storage.usageRetention.apply": "Şimdi uygula",
  "storage.usageRetention.saving": "Kaydediliyor…",
  "storage.usageRetention.running": "Uygulanıyor…",
  "storage.usageRetention.saved": "Kaydedildi",
  "storage.usageRetention.saveBeforeApply": "Sınırı şimdi uygulamadan önce bu değişiklikleri kaydedin.",
  "storage.usageRetention.disabled": "Devre dışı",
  "storage.usageRetention.error": "Kullanım geçmişi boyut sınırı güncellenemedi.",
};

/** Closed multi-locale catalog for the storage usage-retention panel. */
export const USAGE_RETENTION_CATALOG_OVERRIDES: Record<
  LabLocale,
  Record<UsageRetentionCatalogKey, string>
> = {
  en,
  de,
  fr,
  ko,
  zh,
  "zh-TW": zhTW,
  ru,
  ja,
  tr,
};
