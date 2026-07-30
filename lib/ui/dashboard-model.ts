export type ConsoleEnvironment = "production" | "staging";

import type { ConsoleReasonCode } from "./console-copy";

export interface DashboardComponent {
  id:
    | "public_delivery"
    | "editorial"
    | "contact_intake"
    | "media_delivery"
    | "notification_delivery"
    | "deployment_integrity"
    | "recovery_readiness"
    | "autoguard_control_plane";
  label: string;
  symbol: string;
  state: "UNKNOWN" | "DEGRADED";
  summary: string;
  freshness: "NOT RUN";
  evidence: "REMOTE NOT RUN" | "PLANNED";
  reasonCode: ConsoleReasonCode;
}

export interface DashboardSnapshot {
  environment: ConsoleEnvironment;
  operability: "UNKNOWN";
  operabilityLabel: string;
  evidenceMode: "REMOTE NOT RUN";
  displayUpdatedAt: string;
  components: readonly DashboardComponent[];
  gates: readonly {
    id:
      | "contentPublish"
      | "siteDeploy"
      | "contactAccept"
      | "destructiveRecovery";
    label: string;
    symbol: string;
    decision: "DENY";
    required: readonly string[];
    freshness: "NO FRESH EVIDENCE";
  }[];
  incidents: {
    active: 0;
  };
  notification: {
    state: "DEGRADED";
    steps: readonly {
      label: string;
      detail: string;
      state: "LOCAL_PASS" | "NOT_RUN";
    }[];
    note: string;
  };
  deploy: {
    state: "UNKNOWN";
    commitSha: "NOT RUN";
    workerVersion: "NOT RUN";
    receipt: "NOT RUN";
    note: string;
  };
  readiness: {
    state: "UNKNOWN";
    items: readonly {
      label: string;
      detail: string;
      local: boolean;
    }[];
  };
  localVerification: {
    tests: 14;
  };
}

const components: readonly DashboardComponent[] = [
  {
    id: "public_delivery",
    label: "公開配信",
    symbol: "↗",
    state: "UNKNOWN",
    summary: "HTTP・DNS・TLS・canonical・assetを独立probeで確認します。",
    freshness: "NOT RUN",
    evidence: "REMOTE NOT RUN",
    reasonCode: "external_probe_not_configured",
  },
  {
    id: "editorial",
    label: "編集基盤",
    symbol: "✎",
    state: "UNKNOWN",
    summary: "CMS shell・認証negative contract・repository/CIを分離監視します。",
    freshness: "NOT RUN",
    evidence: "REMOTE NOT RUN",
    reasonCode: "cms_failure_only_signal",
  },
  {
    id: "contact_intake",
    label: "問い合わせ受付",
    symbol: "⌁",
    state: "UNKNOWN",
    summary: "Worker・Turnstile・rate limit・D1・Queue enqueueを確認します。",
    freshness: "NOT RUN",
    evidence: "REMOTE NOT RUN",
    reasonCode: "contact_remote_not_run",
  },
  {
    id: "media_delivery",
    label: "メディア配信",
    symbol: "▧",
    state: "UNKNOWN",
    summary: "manifest・private R2・画像変換・known fixtureを確認します。",
    freshness: "NOT RUN",
    evidence: "REMOTE NOT RUN",
    reasonCode: "media_fixture_not_run",
  },
  {
    id: "notification_delivery",
    label: "通知配送",
    symbol: "⌁",
    state: "DEGRADED",
    summary: "安全なenvelope、2xx marker、retry、DLQを追跡します。",
    freshness: "NOT RUN",
    evidence: "PLANNED",
    reasonCode: "notification_remote_not_provisioned",
  },
  {
    id: "deployment_integrity",
    label: "デプロイ整合性",
    symbol: "◇",
    state: "UNKNOWN",
    summary: "exact SHA・Worker version・binding・migrationを照合します。",
    freshness: "NOT RUN",
    evidence: "REMOTE NOT RUN",
    reasonCode: "worker_version_not_reported",
  },
  {
    id: "recovery_readiness",
    label: "復旧準備",
    symbol: "↶",
    state: "UNKNOWN",
    summary: "prior version・D1 bookmark・rehearsal鮮度を確認します。",
    freshness: "NOT RUN",
    evidence: "REMOTE NOT RUN",
    reasonCode: "recovery_rehearsal_not_run",
  },
  {
    id: "autoguard_control_plane",
    label: "Guard制御面",
    symbol: "⊙",
    state: "UNKNOWN",
    summary: "scheduler・D1・Queue・R2・alert heartbeatを自己監視します。",
    freshness: "NOT RUN",
    evidence: "REMOTE NOT RUN",
    reasonCode: "guard_remote_readiness_not_run",
  },
];

const baseSnapshot: Omit<DashboardSnapshot, "environment"> = {
  operability: "UNKNOWN",
  operabilityLabel: "リモート健全性は未判定",
  evidenceMode: "REMOTE NOT RUN",
  displayUpdatedAt: "2026-07-31  /  remote clock unavailable",
  components,
  gates: [
    {
      id: "contentPublish",
      label: "コンテンツ公開",
      symbol: "P",
      decision: "DENY",
      required: ["public", "editorial", "media", "deploy", "guard"],
      freshness: "NO FRESH EVIDENCE",
    },
    {
      id: "siteDeploy",
      label: "サイトデプロイ",
      symbol: "D",
      decision: "DENY",
      required: ["public", "deploy", "recovery", "guard"],
      freshness: "NO FRESH EVIDENCE",
    },
    {
      id: "contactAccept",
      label: "問い合わせ受付",
      symbol: "C",
      decision: "DENY",
      required: ["contact", "notification", "guard"],
      freshness: "NO FRESH EVIDENCE",
    },
    {
      id: "destructiveRecovery",
      label: "破壊的復旧",
      symbol: "R",
      decision: "DENY",
      required: ["deploy", "recovery", "guard"],
      freshness: "NO FRESH EVIDENCE",
    },
  ],
  incidents: {
    active: 0,
  },
  notification: {
    state: "DEGRADED",
    steps: [
      {
        label: "Safe envelope",
        detail: "PII / secret canary 0件",
        state: "LOCAL_PASS",
      },
      {
        label: "Queue consumer",
        detail: "2xx → marker → ACK",
        state: "LOCAL_PASS",
      },
      {
        label: "Provider / DLQ",
        detail: "remote resource未作成",
        state: "NOT_RUN",
      },
    ],
    note: "Provider 2xxとD1 marker間はat-least-onceです。remote rehearsal後に昇格します。",
  },
  deploy: {
    state: "UNKNOWN",
    commitSha: "NOT RUN",
    workerVersion: "NOT RUN",
    receipt: "NOT RUN",
    note: "unknownはallow receiptを作成しません。Guard自身はrollbackを実行しません。",
  },
  readiness: {
    state: "UNKNOWN",
    items: [
      {
        label: "Contract & security",
        detail: "署名・scope・replay・privacy",
        local: true,
      },
      {
        label: "Persistence",
        detail: "D1 migration / restart / idempotency",
        local: true,
      },
      {
        label: "Cloudflare bindings",
        detail: "D1 / Queue / DLQ / R2",
        local: false,
      },
      {
        label: "External observations",
        detail: "probe / provider / shadow",
        local: false,
      },
    ],
  },
  localVerification: {
    tests: 14,
  },
};

export const dashboardSnapshots: Readonly<
  Record<ConsoleEnvironment, DashboardSnapshot>
> = {
  production: {
    ...baseSnapshot,
    environment: "production",
  },
  staging: {
    ...baseSnapshot,
    environment: "staging",
    operabilityLabel: "stagingのリモート健全性は未判定",
  },
};
