import type { Component, Environment } from "../contracts/ops-signal.ts";
import type { ComponentState } from "../domain/component-verdict.ts";
import {
  operationComponentMatrix,
  type Operation,
} from "../domain/gate-policy.ts";
import type { CanonicalOperabilitySnapshotV1 } from "../services/canonical-operability.ts";

export type ConsoleEnvironment = Environment;
export type DashboardState =
  | "HEALTHY"
  | "DEGRADED"
  | "UNHEALTHY"
  | "UNKNOWN"
  | "MAINTENANCE";

export interface DashboardComponent {
  id: Component;
  label: string;
  symbol: string;
  state: DashboardState;
  summary: string;
  freshness: string;
  evidence: string;
  reasonCodes: readonly string[];
  configured: boolean;
  activeIncidentCount: number | null;
}

export interface DashboardGate {
  id: Operation;
  label: string;
  symbol: string;
  decision: "ALLOW" | "DENY";
  required: readonly Component[];
  freshness: string;
  reasonCodes: readonly string[];
  blockedComponents: readonly Component[];
  freeze: boolean;
}

export interface DashboardSnapshot {
  siteId: string;
  environment: ConsoleEnvironment;
  dataAvailability: "LIVE" | "UNAVAILABLE";
  operability: DashboardState;
  operabilityLabel: string;
  evidenceMode: string;
  displayUpdatedAt: string;
  truth: {
    title: string;
    detail: string;
  };
  components: readonly DashboardComponent[];
  gates: readonly DashboardGate[];
  incidents: {
    available: boolean;
    active: number | null;
    truncated: boolean;
    items: readonly {
      incidentId: string;
      component: Component;
      severity: "sev1" | "sev2" | "sev3" | "sev4";
      state:
        | "open"
        | "acknowledged"
        | "mitigating"
        | "monitoring"
        | "manual_required";
      reasonCode: string;
      openedAt: string;
      updatedAt: string;
    }[];
  };
  notification: {
    available: boolean;
    state: DashboardState;
    steps: readonly {
      label: string;
      detail: string;
      state:
        | "OBSERVED"
        | "PENDING"
        | "CONFIGURED"
        | "NOT_CONFIGURED"
        | "NO_EVIDENCE"
        | "UNKNOWN";
    }[];
    note: string;
  };
  deploy: {
    available: boolean;
    state: DashboardState;
    commitSha: string;
    workerVersion: string;
    receipt: string;
    note: string;
  };
  readiness: {
    available: boolean;
    state: "READY" | "NOT_READY" | "UNAVAILABLE";
    items: readonly {
      label: string;
      detail: string;
      state: "READY" | "NOT_READY" | "UNAVAILABLE";
    }[];
  };
  scheduler: {
    state: "FRESH_PASS" | "FRESH_UNKNOWN" | "STALE" | "MISSING";
    displayState: "FRESH" | "UNKNOWN" | "STALE";
    detail: string;
  };
}

interface ComponentMetadata {
  label: string;
  symbol: string;
  summary: string;
  unavailableReason: string;
}

const componentMetadata: Readonly<Record<Component, ComponentMetadata>> = {
  public_delivery: {
    label: "公開配信",
    symbol: "↗",
    summary: "HTTP・DNS・TLS・canonical・assetを独立probeで確認します。",
    unavailableReason: "external_probe_not_configured",
  },
  editorial: {
    label: "編集基盤",
    symbol: "✎",
    summary: "CMS shell・認証negative contract・repository/CIを分離監視します。",
    unavailableReason: "cms_failure_only_signal",
  },
  contact_intake: {
    label: "問い合わせ受付",
    symbol: "⌁",
    summary: "Worker・Turnstile・rate limit・D1・Queue enqueueを確認します。",
    unavailableReason: "contact_remote_not_run",
  },
  media_delivery: {
    label: "メディア配信",
    symbol: "▧",
    summary: "manifest・private R2・画像変換・known fixtureを確認します。",
    unavailableReason: "media_fixture_not_run",
  },
  notification_delivery: {
    label: "通知配送",
    symbol: "⌁",
    summary: "安全なenvelope、2xx marker、retry、DLQを追跡します。",
    unavailableReason: "notification_remote_not_provisioned",
  },
  deployment_integrity: {
    label: "デプロイ整合性",
    symbol: "◇",
    summary: "exact SHA・Worker version・binding・migrationを照合します。",
    unavailableReason: "worker_version_not_reported",
  },
  recovery_readiness: {
    label: "復旧準備",
    symbol: "↶",
    summary: "prior version・D1 bookmark・rehearsal鮮度を確認します。",
    unavailableReason: "recovery_rehearsal_not_run",
  },
  autoguard_control_plane: {
    label: "Guard制御面",
    symbol: "⊙",
    summary: "scheduler・D1・Queue・R2・alert heartbeatを自己監視します。",
    unavailableReason: "guard_remote_readiness_not_run",
  },
};

const componentOrder = Object.keys(componentMetadata) as Component[];

const gateMetadata: Readonly<
  Record<Operation, { label: string; symbol: string }>
> = {
  contentPublish: { label: "コンテンツ公開", symbol: "P" },
  siteDeploy: { label: "サイトデプロイ", symbol: "D" },
  contactAccept: { label: "問い合わせ受付", symbol: "C" },
  destructiveRecovery: { label: "破壊的復旧", symbol: "R" },
};

const gateOrder = Object.keys(gateMetadata) as Operation[];

const readinessMetadata: Readonly<
  Record<
    keyof CanonicalOperabilitySnapshotV1["readiness"]["checks"],
    { label: string; ready: string; notReady: string }
  >
> = {
  runtimeScopePolicy: {
    label: "Runtime scope & policy",
    ready: "固定scopeとreview済みpolicyを確認",
    notReady: "固定scopeまたはpolicyが不足",
  },
  consoleAuthentication: {
    label: "Console authentication",
    ready: "認証設定を確認",
    notReady: "認証設定が不足",
  },
  databaseSchema: {
    label: "D1 schema",
    ready: "必要tableをread-onlyで取得",
    notReady: "D1 schemaを確認できません",
  },
  evidenceStorage: {
    label: "Evidence storage",
    ready: "evidence bindingを確認",
    notReady: "evidence bindingが不足",
  },
  cmsCredentials: {
    label: "CMS credentials",
    ready: "credential pairの構成を確認",
    notReady: "credential pairが不足",
  },
  notificationPath: {
    label: "Notification path",
    ready: "Queue/provider設定あり（健全性は別証跡）",
    notReady: "Queue/provider設定が不足",
  },
  scheduledManifest: {
    label: "Scheduled manifest",
    ready: "review済み9 checkを確認",
    notReady: "scheduled manifestが不一致",
  },
  schedulerHeartbeat: {
    label: "Scheduler heartbeat",
    ready: "fresh PASS heartbeatを確認",
    notReady: "fresh PASS heartbeatなし",
  },
};

function dashboardState(state: ComponentState): DashboardState {
  return state.toUpperCase() as DashboardState;
}

function displayInstant(value: string | null): string {
  if (value === null) return "NOT AVAILABLE";
  return value.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
}

function overallLabel(state: DashboardState): string {
  switch (state) {
    case "HEALTHY":
      return "全componentにfreshな正常証跡があります";
    case "DEGRADED":
      return "劣化したcomponentがあります";
    case "UNHEALTHY":
      return "確認済みの障害またはactive Incidentがあります";
    case "MAINTENANCE":
      return "期限付きfreezeが有効です";
    case "UNKNOWN":
      return "不足・期限切れ・未設定の証跡があります";
  }
}

function componentFreshness(
  component: CanonicalOperabilitySnapshotV1["components"][number],
): string {
  if (!component.configured) return "NO ACTIVE POLICY";
  if (component.fresh && component.freshUntil !== null) {
    return `FRESH · ${displayInstant(component.freshUntil)}`;
  }
  return component.lastObservedAt === null
    ? "NO FRESH EVIDENCE"
    : `STALE · last ${displayInstant(component.lastObservedAt)}`;
}

function componentEvidence(
  component: CanonicalOperabilitySnapshotV1["components"][number],
): string {
  if (component.observationIds.length > 0) {
    return `${component.observationIds.length} MATCHED OBSERVATION${
      component.observationIds.length === 1 ? "" : "S"
    }`;
  }
  return component.lastObservedAt === null
    ? "NO REMOTE EVIDENCE"
    : "OBSERVED · NOT SUFFICIENT";
}

function schedulerProjection(
  snapshot: CanonicalOperabilitySnapshotV1,
): DashboardSnapshot["scheduler"] {
  const state = snapshot.scheduler.state.toUpperCase() as
    DashboardSnapshot["scheduler"]["state"];
  const displayState =
    state === "FRESH_PASS"
      ? "FRESH"
      : state === "STALE"
        ? "STALE"
        : "UNKNOWN";
  const observed =
    snapshot.scheduler.observedAt === null
      ? "heartbeatなし"
      : `observed ${displayInstant(snapshot.scheduler.observedAt)}`;
  return {
    state,
    displayState,
    detail: `${snapshot.scheduler.reasonCode} · ${observed}`,
  };
}

export function toDashboardSnapshot(
  snapshot: CanonicalOperabilitySnapshotV1,
): DashboardSnapshot {
  const componentById = new Map(
    snapshot.components.map((component) => [component.component, component]),
  );
  const components = componentOrder.map((id): DashboardComponent => {
    const projection = componentById.get(id);
    if (!projection) {
      return {
        id,
        label: componentMetadata[id].label,
        symbol: componentMetadata[id].symbol,
        summary: componentMetadata[id].summary,
        state: "UNKNOWN",
        freshness: "NO ACTIVE POLICY",
        evidence: "NO REMOTE EVIDENCE",
        reasonCodes: ["component_projection_missing"],
        configured: false,
        activeIncidentCount: null,
      };
    }
    return {
      id,
      label: componentMetadata[id].label,
      symbol: componentMetadata[id].symbol,
      summary: componentMetadata[id].summary,
      state: dashboardState(projection.state),
      freshness: componentFreshness(projection),
      evidence: componentEvidence(projection),
      reasonCodes:
        projection.reasonCodes.length > 0
          ? projection.reasonCodes
          : ["component_reason_missing"],
      configured: projection.configured,
      activeIncidentCount: projection.activeIncidentCount,
    };
  });
  const gateById = new Map(
    snapshot.gates.map((gate) => [gate.operation, gate]),
  );
  const gates = gateOrder.map((id): DashboardGate => {
    const projection = gateById.get(id);
    return {
      id,
      ...gateMetadata[id],
      decision: projection?.decision === "allow" ? "ALLOW" : "DENY",
      required: operationComponentMatrix[id],
      freshness:
        projection?.freshUntil == null
          ? "NO FRESH EVIDENCE"
          : `FRESH · ${displayInstant(projection.freshUntil)}`,
      reasonCodes:
        projection?.reasonCodes.length
          ? projection.reasonCodes
          : ["gate_projection_missing"],
      blockedComponents:
        projection?.blockedComponents ?? operationComponentMatrix[id],
      freeze: projection?.freeze ?? snapshot.freeze.active,
    };
  });
  const notificationComponent = components.find(
    (component) => component.id === "notification_delivery",
  );
  const notificationPathReady =
    snapshot.readiness.checks.notificationPath === "ready";
  const postDeploy = snapshot.deployment.postDeploy;
  const identity = snapshot.deployment.identity;
  const deploymentComponent = components.find(
    (component) => component.id === "deployment_integrity",
  );
  const readinessItems = (
    Object.keys(readinessMetadata) as Array<
      keyof typeof readinessMetadata
    >
  ).map((key) => {
    const ready = snapshot.readiness.checks[key] === "ready";
    return {
      label: readinessMetadata[key].label,
      detail: ready
        ? readinessMetadata[key].ready
        : readinessMetadata[key].notReady,
      state: ready ? ("READY" as const) : ("NOT_READY" as const),
    };
  });
  const overall = dashboardState(snapshot.overall);
  const scheduler = schedulerProjection(snapshot);
  const configuredComponents = components.filter(
    (component) => component.configured,
  ).length;

  return {
    siteId: snapshot.siteId,
    environment: snapshot.environment,
    dataAvailability: "LIVE",
    operability: overall,
    operabilityLabel: overallLabel(overall),
    evidenceMode: "LIVE D1",
    displayUpdatedAt: displayInstant(snapshot.generatedAt),
    truth: {
      title: "D1の最新スナップショットを表示中",
      detail:
        configuredComponents === components.length
          ? "全component policyを評価しました。状態は証跡の鮮度とGate判定を反映しています。"
          : `${configuredComponents}/8 componentにpolicyがあります。未設定componentはUNKNOWN、依存GateはDENYです。`,
    },
    components,
    gates,
    incidents: {
      available: true,
      active: snapshot.incidents.active,
      truncated: snapshot.incidents.truncated,
      items: snapshot.incidents.items,
    },
    notification: {
      available: true,
      state: notificationComponent?.state ?? "UNKNOWN",
      steps: [
        {
          label: "D1 outbox",
          detail:
            `${snapshot.notifications.outbox.pending} pending · ` +
            `${snapshot.notifications.outbox.enqueued} enqueued · ` +
            `${snapshot.notifications.outbox.blocked} blocked`,
          state:
            snapshot.notifications.outbox.pending > 0
              ? "PENDING"
              : "OBSERVED",
        },
        {
          label: "Queue / provider config",
          detail: notificationPathReady
            ? "runtime設定あり（配送成功とは別）"
            : "runtime設定が不足",
          state: notificationPathReady ? "CONFIGURED" : "NOT_CONFIGURED",
        },
        {
          label: "Provider 2xx marker",
          detail:
            snapshot.notifications.deliveries.total > 0
              ? `${snapshot.notifications.deliveries.total} durable · latest ${displayInstant(
                  snapshot.notifications.deliveries.latestDeliveredAt,
                )}`
              : "durable marker 0件",
          state:
            snapshot.notifications.deliveries.total > 0
              ? "OBSERVED"
              : "NO_EVIDENCE",
        },
      ],
      note:
        snapshot.notifications.outbox.oldestPendingAt == null
          ? "pending outboxはありません。0件はD1読取成功後の値です。"
          : `最古pending: ${displayInstant(
              snapshot.notifications.outbox.oldestPendingAt,
            )}`,
    },
    deploy: {
      available: true,
      state: deploymentComponent?.state ?? "UNKNOWN",
      commitSha:
        identity.state === "missing" ? "NOT OBSERVED" : identity.commitSha,
      workerVersion:
        identity.state === "missing"
          ? "NOT OBSERVED"
          : identity.workerVersionId,
      receipt:
        postDeploy === null
          ? "NOT OBSERVED"
          : `${postDeploy.status.toUpperCase()} · ${
              postDeploy.checkedAt === null
                ? "CHECK PENDING"
                : displayInstant(new Date(postDeploy.checkedAt * 1_000).toISOString())
            }`,
      note:
        identity.state === "missing"
          ? "runtime identityがありません。request値からactive deploymentを推測しません。"
          : `runtime identityは${identity.state.toUpperCase()}です。Guardはrollbackを実行しません。`,
    },
    readiness: {
      available: true,
      state:
        snapshot.readiness.status === "ready" ? "READY" : "NOT_READY",
      items: readinessItems,
    },
    scheduler,
  };
}

export function createUnavailableDashboardSnapshot(
  environment: ConsoleEnvironment,
  siteId = "dfconnect",
): DashboardSnapshot {
  const components = componentOrder.map(
    (id): DashboardComponent => ({
      id,
      label: componentMetadata[id].label,
      symbol: componentMetadata[id].symbol,
      summary: componentMetadata[id].summary,
      state: "UNKNOWN",
      freshness: "NOT RUN",
      evidence: "REMOTE NOT RUN",
      reasonCodes: [componentMetadata[id].unavailableReason],
      configured: false,
      activeIncidentCount: null,
    }),
  );
  const gates = gateOrder.map(
    (id): DashboardGate => ({
      id,
      ...gateMetadata[id],
      decision: "DENY",
      required: operationComponentMatrix[id],
      freshness: "NO FRESH EVIDENCE",
      reasonCodes: ["operability_snapshot_unavailable"],
      blockedComponents: operationComponentMatrix[id],
      freeze: false,
    }),
  );
  const unavailableReadiness = (
    Object.keys(readinessMetadata) as Array<
      keyof typeof readinessMetadata
    >
  ).map((key) => ({
    label: readinessMetadata[key].label,
    detail: "remote stateを取得できません",
    state: "UNAVAILABLE" as const,
  }));

  return {
    siteId,
    environment,
    dataAvailability: "UNAVAILABLE",
    operability: "UNKNOWN",
    operabilityLabel: "リモート健全性は未判定",
    evidenceMode: "REMOTE NOT RUN",
    displayUpdatedAt: "remote clock unavailable",
    truth: {
      title: "最新のリモート証跡は未取得",
      detail:
        "D1 snapshotを取得できません。Incident件数は不明で、すべてのGateは安全側でDENYです。",
    },
    components,
    gates,
    incidents: {
      available: false,
      active: null,
      truncated: false,
      items: [],
    },
    notification: {
      available: false,
      state: "UNKNOWN",
      steps: [
        {
          label: "D1 outbox",
          detail: "件数を取得できません",
          state: "UNKNOWN",
        },
        {
          label: "Queue / provider config",
          detail: "remote設定を確認できません",
          state: "UNKNOWN",
        },
        {
          label: "Provider 2xx marker",
          detail: "配送証跡を取得できません",
          state: "UNKNOWN",
        },
      ],
      note: "通知経路は未判定です。0件または正常として扱いません。",
    },
    deploy: {
      available: false,
      state: "UNKNOWN",
      commitSha: "NOT RUN",
      workerVersion: "NOT RUN",
      receipt: "NOT RUN",
      note: "deployment identityとpost-deploy結果を取得できません。",
    },
    readiness: {
      available: false,
      state: "UNAVAILABLE",
      items: unavailableReadiness,
    },
    scheduler: {
      state: "MISSING",
      displayState: "UNKNOWN",
      detail: "remote heartbeat unavailable",
    },
  };
}

export const dashboardSnapshots: Readonly<
  Record<ConsoleEnvironment, DashboardSnapshot>
> = {
  production: createUnavailableDashboardSnapshot("production"),
  staging: createUnavailableDashboardSnapshot("staging"),
};
