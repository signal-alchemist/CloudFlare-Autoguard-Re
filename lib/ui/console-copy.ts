export type ConsoleReasonCode =
  | "external_probe_not_configured"
  | "cms_failure_only_signal"
  | "contact_remote_not_run"
  | "media_fixture_not_run"
  | "notification_remote_not_provisioned"
  | "worker_version_not_reported"
  | "recovery_rehearsal_not_run"
  | "guard_remote_readiness_not_run";

const CONSOLE_REASON_COPY: Readonly<Record<ConsoleReasonCode, string>> = {
  external_probe_not_configured:
    "外部2地点probeと接続IP attestationが未設定です。",
  cms_failure_only_signal:
    "現行CMS signalはfailure-onlyで、正常性を証明できません。",
  contact_remote_not_run:
    "本番D1/Queue/Turnstileのread-only確認が未実施です。",
  media_fixture_not_run:
    "R2/Imagesのremote fixture検証が未実施です。",
  notification_remote_not_provisioned:
    "ローカル配送順序はPASS、Queue・DLQ・providerは未provisionです。",
  worker_version_not_reported:
    "CMS workflowが実Worker versionをまだ送信していません。",
  recovery_rehearsal_not_run:
    "復旧rehearsalとowner承認のremote証跡がありません。",
  guard_remote_readiness_not_run:
    "ローカルbuildはPASSですが、deployed readinessは未取得です。",
};

const UNKNOWN_REASON_COPY = "詳細な理由は安全な証跡から取得できません。";

export function resolveConsoleReason(reasonCode: string): string {
  if (Object.hasOwn(CONSOLE_REASON_COPY, reasonCode)) {
    return CONSOLE_REASON_COPY[reasonCode as ConsoleReasonCode];
  }
  return UNKNOWN_REASON_COPY;
}
